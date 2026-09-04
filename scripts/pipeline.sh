#!/usr/bin/env bash
#
# Corpo do step "Executar Pipeline Modular" do engine.yml.
#
# POR QUE ESTE CODIGO NAO MORA NO `run:` DO WORKFLOW:
# O runner ECOA o bloco run: inteiro no topo do log do step, dentro de um
# ##[group]. Com o script inline isso eram 523 linhas de codigo-fonte antes da
# primeira linha de saida real (eram 339 em 12/07/2026 -- cresceu 54% em duas
# semanas). Como arquivo, o eco vira uma linha e a saida do pipeline passa a ser
# a primeira coisa visivel no log.
#
# Efeito colateral bem-vindo: o bloco run: deixa de ter tamanho relevante, entao
# o teto de 21000 caracteres para expressoes do GitHub (que ja quebrou este
# workflow uma vez, com "Exceeded max expression length 21000") deixa de existir
# como restricao ao editar este arquivo.
#
# Entradas vem por env, declaradas no step: GH_CLONE_TOKEN, LOGIN_REGION,
# SECRETS_CONTEXT, GH_TOKEN, MANIFEST_PATH_INPUT.
# SECRETS_CONTEXT and GH_CLONE_TOKEN are un-exported right after set -eo (see there).

# ==============================================================================
# CONFIGURAÇÕES E CORES
# ==============================================================================
# -e e -o pipefail reproduzem EXATAMENTE o shell que o Actions usava quando
# este script vivia dentro do bloco run: (bash --noprofile --norc -e -o
# pipefail). Sem o -e aqui, comando que falha deixaria de abortar o step e a
# mudanca de arquivo teria alterado a semantica de falha do pipeline inteiro.
set -eo pipefail
export LC_ALL=C.UTF-8   # >>> NOVO — garante que `grep -P` (usado no backstop de lock) funcione, independente do locale padrão do runner

# ------------------------------------------------------------------------------
# THE SECRETS STAY IN THIS SHELL AND OUT OF EVERY CHILD PROCESS.
#
# SECRETS_CONTEXT is `toJSON(secrets)`: every secret of the caller's repository
# and organisation, serialised. That transport is unavoidable -- the names the
# manifest asks for (AUTH_CLOUDFLARE_<account>, or a `secret_name` the customer
# chose) cannot be declared statically in the workflow. What was not
# unavoidable is the step's `env:` EXPORTING it: `terraform`, every provider
# plugin, `git`, `aws`, `gh` and any `local-exec` a plan runs (the AWS
# generator emits one for the ECS cleanup) inherited the whole blob.
#
# `export -n` keeps the value as a plain shell variable -- the lookups below
# (`echo "$SECRETS_CONTEXT" | jq ...`, here and in the sourced
# scripts/auth/*.sh) read it exactly as before -- and removes it from the
# environment handed to child processes. Same for GH_CLONE_TOKEN, which is only
# ever spliced into a clone URL. GH_TOKEN stays exported on purpose: `gh` is a
# child process and reads it from the environment.
#
# What a child still sees is what its provider needs and nothing else:
# CLOUDFLARE_API_TOKEN for the account the state uses, AWS credentials through
# named profiles. Audit of 2026-09-04, medium finding.
# ------------------------------------------------------------------------------
export -n SECRETS_CONTEXT GH_CLONE_TOKEN

echo "🕐 Step started at $(date -u '+%H:%M:%S') UTC"

BLUE='\033[0;34m'
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

# >>> NOVO — Camada "marcação de dono": grava no hostname do runner o ID
# desta run do Actions. O Terraform tira o campo Info.Who do lock de
# usuário@hostname (não existe flag pra injetar metadado direto), então
# esse truque deixa todo lock criado por este job identificável depois.
# Runners hospedados do GitHub têm sudo sem senha.
RUN_TAG="gh-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
sudo hostname "$RUN_TAG" 2>/dev/null || true

ENGINE_PATH=$(readlink -f .struct8-engine)
AUTH_SCRIPTS="$ENGINE_PATH/scripts/auth"

if [ ! -d "$AUTH_SCRIPTS" ]; then
    echo "❌ Critical error: scripts/auth folder not found"
    exit 1
fi

chmod +x $AUTH_SCRIPTS/*.sh
source "$AUTH_SCRIPTS/aws.sh"

# ==============================================================================
# FUNÇÃO DE LOG DE DEBUG
# ==============================================================================
debug_auth_status() {
    local context=$1
    echo "🔎 [DEBUG] Checking identity ($context):"
    if [ -n "$AWS_PROFILE" ]; then echo "   - AWS_PROFILE: $AWS_PROFILE"; else echo "   - AWS_PROFILE: (unset)"; fi
    if [ -n "$AWS_REGION" ]; then echo "   - AWS_REGION: $AWS_REGION"; else echo "   - AWS_REGION: (unset)"; fi

    # Verifica identidade real (se tiver credenciais carregadas)
    aws sts get-caller-identity --query "Arn" --output text 2>/dev/null || echo "   - (no active credentials in this shell)"
    echo "---------------------------------------------------"
}

# ==============================================================================
# >>> HELPER: espelha a saída de um comando no console EM TEMPO REAL e num
# arquivo (o arquivo serve SÓ pro grep de "Error acquiring the state lock"
# logo abaixo — não serve pra recuperar log pós-cancelamento: o tee grava no
# arquivo em block-buffer, então num SIGKILL o arquivo tem MENOS conteúdo do
# que o console já mostrou).
#
# NÃO envolver isto em `script`/PTY. Testado e REPROVADO: o `script` insere
# um processo a mais entre o terraform e o stdout do step, e o stdout dele
# (pipe, não-TTY) é block-buffered (~4-8KB) — o `-f` só dá flush no arquivo
# de transcript, não nesse stdout. Resultado: o log só aparecia no FINAL.
#
# O caminho abaixo é o que funciona: terraform é Go e escreve em stdout SEM
# buffer (write() direto), o pipe não segura nada, e o único buffer real é o
# do tee — que o `stdbuf -oL` já deixa line-buffered. Os heartbeats de
# progresso ("Still creating... [10s elapsed]") o terraform emite mesmo sem
# TTY, então não se perde liveness aqui.
#
# O arquivo fica no diretório do próprio state (./.struct8-live.log), então
# é naturalmente isolado por path — seguro no modo parallel_execution.
# Retorna o exit code REAL do comando (não o do tee).
# ==============================================================================
_stream_cmd() {
    local logfile="./.struct8-live.log"
    : > "$logfile"   # zera o log deste comando

    # ORDEM IMPORTA: o tee grava o arquivo CRU (sem carimbo) — o grep de lock
    # casa em '^\s*ID:'/'^\s*Who:' e um prefixo quebraria. O carimbo é só no
    # console. printf BUILTIN do bash (não awk: o mawk do Ubuntu pode não ter
    # strftime, e se ele morresse a saída sumiria inteira).
    "$@" 2>&1 \
        | stdbuf -oL tee "$logfile" \
        | while IFS= read -r _line; do printf '%(%H:%M:%S)T | %s\n' -1 "$_line"; done
    return ${PIPESTATUS[0]}
}

# ==============================================================================
# >>> NOVO — FUNÇÃO: backstop verificado (camada 4).
# Só entra em ação se o terraform falhar por lock ativo. NUNCA destrava por
# idade/estimativa de tempo — só se a API do GitHub confirmar que a run dona
# do lock já terminou (fato, não chute). Se não conseguir identificar/confirmar
# a run dona, não mexe em nada e falha normalmente, igual ao comportamento atual.
# A saída ao vivo (console + arquivo) é feita pelo _stream_cmd acima.
# ==============================================================================
run_tf_with_stale_lock_recovery() {
    local status lock_id who_str owner_run_id run_status
    local logfile="./.struct8-live.log"

    _stream_cmd "$@"
    status=$?

    if [ $status -ne 0 ] && grep -q "Error acquiring the state lock" "$logfile"; then
        lock_id=$(grep -oP '^\s*ID:\s+\K\S+'  "$logfile" | head -n1)
        who_str=$(grep -oP '^\s*Who:\s+\K.*' "$logfile" | head -n1)
        owner_run_id=$(echo "$who_str" | grep -oP 'gh-\K[0-9]+')

        if [ -z "$owner_run_id" ]; then
            echo "🔒 Lock is active and its owner is not an Actions run (likely a manual apply). Leaving it alone -- failing."
            return $status
        fi

        echo "🔎 Lock belongs to run #$owner_run_id. Checking its real status via the API..."
        run_status=$(gh run view "$owner_run_id" --json status --jq '.status' 2>/dev/null)

        if [ "$run_status" == "completed" ]; then
            echo "♻️  Run #$owner_run_id has finished (confirmed via the API). Forcing unlock and retrying..."
            terraform force-unlock -force "$lock_id"
            _stream_cmd "$@"
            status=$?
        else
            echo "⏳ Run #$owner_run_id is still '$run_status' -- the lock is real and active. Leaving it alone."
        fi
    fi

    return $status
}

# ==============================================================================
# FUNÇÃO PRINCIPAL: Execução do Terraform
# ==============================================================================
run_terraform_process() {
    local path=$1
    local action=$2
    local auth_json=$3
    local provider=$4
    # Credenciais de nuvens ESTRANGEIRAS que este state também usa, além
    # da própria ($auth_json). Existe porque um state deixou de ser de um
    # provider só: um state AWS pode legitimamente escrever um
    # cloudflare_dns_record (domínio registrado na Cloudflare apontando
    # pra um recurso AWS), e aí o apply falha por falta de token num
    # código que está correto.
    # Default "[]" mantém compatível com manifesto antigo, que não traz
    # o campo -- o laço abaixo simplesmente não itera.
    local additional_auth=${5:-[]}
    local label="[$path]"

    local color=$BLUE
    if [ "$provider" == "azure" ]; then color=$CYAN; fi
    if [ "$provider" == "cloudflare" ]; then color=$GREEN; fi
    if [ "$provider" == "google" ]; then color=$YELLOW; fi
    if [ "$provider" == "oci" ]; then color=$RED; fi

    (
        cd "$path" || { echo -e "${RED}❌ ERROR: folder not found: $path${NC}"; exit 1; }

        # =========================================================
        # 🔍 DEBUG LOG: LISTANDO ARQUIVOS ANTES DO TERRAFORM
        # =========================================================
        echo -e "${CYAN}---------------------------------------------------${NC}"
        echo -e "${CYAN}🔎 [DEBUG] Listing files on the runner (${path}):${NC}"
        echo -e "${CYAN}Absolute path: $(pwd)${NC}"
        ls -la
        echo -e "${CYAN}---------------------------------------------------${NC}"

        # ---------------------------------------------------------
        # PASSO 1: TERRAFORM INIT
        # ---------------------------------------------------------
        echo -e "${color}▶️ ${label} Initializing backend (state)...${NC}"

        # ---------------------------------------------------------
        # PASSO 1: TERRAFORM INIT
        # ---------------------------------------------------------
        echo -e "${color}▶️ ${label} Initializing backend (state)...${NC}"

        # Limpa ambiente para garantir que o Init use apenas o profile
        unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_REGION

        # SOLUÇÃO DO PROBLEMA DE LOCK:
        # Injetamos '-backend-config="profile=backend"'
        # Isso força o Terraform a salvar no .terraform/terraform.tfstate que
        # ele DEVE usar o profile 'backend' para operações de estado (S3/Dynamo),
        # ignorando as variáveis de ambiente que vamos carregar no passo 2.

        terraform init -reconfigure -input=false \
            -backend-config="profile=backend" \
            -backend-config="region=$BACKEND_REGION"

        # ---------------------------------------------------------
        # PASSO 2: PREPARAÇÃO DO TARGET
        # ---------------------------------------------------------

        # Cloudflare handling
        if [ "$provider" == "cloudflare" ]; then
            # Prioriza o secret_name vindo do manifest, se não existir, usa o fallback antigo
            local secret_key=$(echo "$auth_json" | jq -r '.secret_name // empty')

            if [ -z "$secret_key" ]; then
                local acc_id=$(echo "$auth_json" | jq -r '.account_id')
                secret_key="AUTH_CLOUDFLARE_${acc_id}"
            fi

            echo "🔑 Looking up secret: $secret_key"
            local token=$(echo "$SECRETS_CONTEXT" | jq -r --arg key "$secret_key" '.[$key]')

            if [ "$token" == "null" ] || [ -z "$token" ]; then
                echo "❌ Error: secret '$secret_key' not found."
                exit 1
            fi
            export CLOUDFLARE_API_TOKEN="$token"
        fi

        # Credenciais ADICIONAIS (nuvens estrangeiras usadas por este state).
        #
        # Mantido SEPARADO do bloco acima de propósito: aquele é o caminho
        # do provider próprio, já em produção, e não muda aqui. A pequena
        # duplicação é o preço de não mexer no que funciona.
        #
        # `< <(...)` e não `... | while`: um pipe roda o laço em SUBSHELL,
        # e os `export` morreriam com ela -- o terraform rodaria sem os
        # tokens, sem erro nenhum no log.
        if [ -n "$additional_auth" ] && [ "$additional_auth" != "[]" ]; then
            while IFS= read -r extra; do
                [ -z "$extra" ] && continue
                local extra_provider=$(echo "$extra" | jq -r '.provider')
                local extra_secret=$(echo "$extra" | jq -r '.secret_name // empty')

                if [ -z "$extra_secret" ]; then
                    local extra_acc=$(echo "$extra" | jq -r '.account_id')
                    local extra_up=$(echo "$extra_provider" | tr '[:lower:]' '[:upper:]')
                    extra_secret="AUTH_${extra_up}_${extra_acc}"
                fi

                echo "🔑 Additional credential ($extra_provider): $extra_secret"
                local extra_token=$(echo "$SECRETS_CONTEXT" | jq -r --arg key "$extra_secret" '.[$key]')

                if [ "$extra_token" == "null" ] || [ -z "$extra_token" ]; then
                    echo "❌ Error: secret '$extra_secret' not found (required by $path)."
                    exit 1
                fi

                case "$extra_provider" in
                    cloudflare)
                        export CLOUDFLARE_API_TOKEN="$extra_token"
                        ;;
                    *)
                        # Falha alto: seguir sem a variável faria o apply
                        # quebrar depois, com uma mensagem do provider que
                        # não aponta pra cá.
                        echo "❌ Error: additional provider '$extra_provider' has no environment variable mapped in this engine."
                        exit 1
                        ;;
                esac
            done < <(echo "$additional_auth" | jq -c '.[]')
        fi

        local script_file="$AUTH_SCRIPTS/${provider}.sh"

        if [ -f "$script_file" ]; then
            echo "🔶 Authenticating $provider (target)..."
            source "$script_file"
            "auth_${provider}" "$auth_json" "target"

            # Debug: Mostra que agora estamos logados como TARGET
            if [ "$provider" == "aws" ]; then
                debug_auth_status "TARGET AUTH"
            fi
        else
            if [ "$provider" != "cloudflare" ]; then
                 echo "⚠️  Warning: no authentication script found for '$provider'."
            fi
        fi

        # ---------------------------------------------------------
        # PASSO 3: EXECUÇÃO DO TERRAFORM
        # ---------------------------------------------------------
        echo -e "${color}▶️ ${label} Running terraform $action...${NC}"

        if [ "$action" == "plan" ]; then
          run_tf_with_stale_lock_recovery terraform plan -input=false

        elif [ "$action" == "apply" ]; then
          echo -e "${color}▶️ ${label} Running terraform apply...${NC}"
          run_tf_with_stale_lock_recovery terraform apply -auto-approve -input=false
          APPLY_STATUS=$?

        # INÍCIO DA NOVA LÓGICA DE IMPORT (GERAÇÃO PARA REVISÃO)
        elif [ "$action" == "import" ]; then
          echo -e "${color}📥 ${label} Generating import draft...${NC}"

          # 1. Limpeza preventiva absoluta
          rm -f generated_resources.tf import.tfplan generated_resources.json

          # 2. Executa a geração. Usamos '|| true' aqui porque o gerador experimental
          # quase sempre gera avisos ou erros de conflito que não devem travar o pipeline
          # de geração de rascunho.
          terraform plan -generate-config-out=generated_resources.tf -out=import.tfplan -input=false || echo "⚠️ Warning: the generator hit HCL conflicts, continuing anyway to produce the draft."

          # 3. Verifica se pelo menos o arquivo .tf foi gerado (mesmo com erros de validação)
          if [ -f "generated_resources.tf" ]; then
              echo -e "${color}📄 HCL file generated. Converting it to JSON for the front end...${NC}"

              # Tenta gerar o JSON. Se falhar por erro no plano, criamos um JSON básico de sinalização
              if terraform show -json import.tfplan > generated_resources.raw.json 2>/dev/null; then
                  # ---------------------------------------------------------------
                  # SENSITIVE VALUES COME OUT BEFORE THE FILE EXISTS UNDER ITS FINAL
                  # NAME. `terraform show -json` writes every value the provider read
                  # and only FLAGS the sensitive ones (after_sensitive,
                  # sensitive_values). publish-gitops.sh commits this file to the
                  # customer's repository, so the raw output would put e.g. an SSM
                  # parameter's value into git history -- which is what the plan
                  # branch above already prevents and this branch did not: on
                  # 2026-09-04, 87 raw files were found committed in one account.
                  #
                  # Unlike the plan, the values here ARE the payload -- the diagram is
                  # rebuilt from planned_values -- so nothing is dropped wholesale.
                  # Only the leaves the plan flags as sensitive go, and they become
                  # `null`, not a marker string: the reader (ImportTab / planParser)
                  # copies values straight into the node's parameters, and a marker
                  # would be compiled into the next main.tf and written to the cloud
                  # on apply. `null` is what every unset attribute already looks like
                  # in this file.
                  #
                  # The same leaf lives in up to four sections and each is handled:
                  # resource_changes (before/after), planned_values, prior_state and
                  # configuration (constant_value). planned_values' own
                  # sensitive_values was MEASURED to miss attributes that
                  # resource_changes flags (aws_ssm_parameter.value, terraform 1.5.7),
                  # so the flags from resource_changes are applied on top, by address.
                  # Root module only, which is all the reader supports.
                  #
                  # LIMIT: this covers what the PROVIDER marks sensitive. A Lambda's
                  # environment variables are not marked (aws provider 5.x/6.x) and
                  # stay -- the same limit the plan branch has.
                  #
                  # `redacted_attributes` lists what was removed, so the diagram, or a
                  # person reading the repository, can tell "removed" from "never set".
                  # ---------------------------------------------------------------
                  if jq -e '
                    def strip($v; $s):
                      if $s == true then null
                      elif ($s | type) == "object" and ($v | type) == "object" then
                        reduce ($v | keys_unsorted[]) as $k ({}; .[$k] = strip($v[$k]; ($s[$k] // false)))
                      elif ($s | type) == "array" and ($v | type) == "array" then
                        [ range(0; $v | length) as $i | strip($v[$i]; ($s[$i] // false)) ]
                      else $v
                      end;

                    def child_flag($s; $k):
                      if $s == true then true
                      elif ($s | type) == "object" and ($k | type) == "string" then ($s[$k] // false)
                      elif ($s | type) == "array" and ($k | type) == "number" then ($s[$k] // false)
                      else false
                      end;

                    def strip_expr($e; $s):
                      if ($e | type) == "array" then
                        [ range(0; $e | length) as $i | strip_expr($e[$i]; child_flag($s; $i)) ]
                      elif ($e | type) == "object" and ($e | has("constant_value")) then
                        $e + { constant_value: strip($e.constant_value; $s) }
                      elif ($e | type) == "object" then
                        reduce ($e | keys_unsorted[]) as $k ({}; .[$k] = strip_expr($e[$k]; child_flag($s; $k)))
                      else $e
                      end;

                    def block_of($a):
                      if ($a | endswith("]")) then $a[:($a | rindex("["))] else $a end;

                    def strip_change:
                      . as $c
                      | .before = strip($c.before; ($c.before_sensitive // false))
                      | .after  = strip($c.after;  ($c.after_sensitive  // false));

                    def strip_module($flags):
                      (if has("resources") then
                         .resources |= [ .[] | . as $r
                           | .values = strip(strip($r.values; ($r.sensitive_values // false)); ($flags[$r.address] // false)) ]
                       else . end)
                      | (if has("child_modules") then .child_modules |= [ .[] | strip_module($flags) ] else . end);

                    def strip_config($byblock):
                      if has("resources") then
                        .resources |= [ .[] | . as $r
                          | if has("expressions") then
                              .expressions |= (reduce ($byblock[block_of($r.address)] // [])[] as $s (.; strip_expr(.; $s)))
                            else . end ]
                      else . end;

                    . as $plan
                    | (reduce ($plan.resource_changes // [])[] as $rc ({}; .[$rc.address] = ($rc.change.after_sensitive // false))) as $after
                    | (reduce ($plan.resource_changes // [])[] as $rc ({}; .[$rc.address] = ($rc.change.before_sensitive // false))) as $before
                    | (reduce ($plan.resource_changes // [])[] as $rc ({}; .[block_of($rc.address)] += [ ($rc.change.after_sensitive // false) ])) as $byblock
                    | (if has("resource_changes") then .resource_changes |= [ .[] | .change |= strip_change ] else . end)
                    | (if has("resource_drift")   then .resource_drift   |= [ .[] | .change |= strip_change ] else . end)
                    | (if (.planned_values.root_module? // null) != null
                       then .planned_values.root_module |= strip_module($after) else . end)
                    | (if (.prior_state.values.root_module? // null) != null
                       then .prior_state.values.root_module |= (strip_module($before) | strip_module($after)) else . end)
                    | (if (.configuration.root_module? // null) != null
                       then .configuration.root_module |= strip_config($byblock) else . end)
                    | .redacted_attributes = [ ($plan.resource_changes // [])[] | .address as $a
                        | (.change.after_sensitive // {})
                        | if (type == "object" or type == "array") then paths(. == true) else empty end
                        | ($a + "." + (map(tostring) | join("."))) ]
                  ' generated_resources.raw.json > generated_resources.json; then
                      rm -f generated_resources.raw.json
                      echo -e "${color}✅ JSON generated successfully (sensitive values removed).${NC}"
                  else
                      # Without a trustworthy redaction NOTHING reaches the repository:
                      # failing visibly is preferable to committing a file that may hold
                      # a secret. publish-gitops.sh only runs on success, so exiting here
                      # is what keeps the raw file out.
                      rm -f generated_resources.raw.json generated_resources.json
                      echo -e "${RED}❌ Critical error: could not remove the sensitive values from the generated JSON; refusing to save it to the repository.${NC}"
                      exit 1
                  fi
              else
                  rm -f generated_resources.raw.json
                  echo "{\"info\": \"The HCL was generated but the plan has validation errors. Review the .tf file by hand.\"}" > generated_resources.json
                  echo -e "${YELLOW}⚠️ Warning: could not generate the detailed JSON because the plan has errors.${NC}"
              fi

              echo -e "${color}⏳ ${label} Drafts are ready for review.${NC}"
              touch "$GITHUB_WORKSPACE/.needs_commit"
          else
              echo -e "${RED}❌ Critical error: terraform could not even produce the draft .tf file.${NC}"
              exit 1
          fi

        elif [ "$action" == "destroy" ]; then

          run_tf_with_stale_lock_recovery terraform destroy -auto-approve -input=false
          DESTROY_STATUS=$? # Captura o status do destroy

          if [ $DESTROY_STATUS -eq 0 ]; then
              echo -e "${color}▶️ ${label} Destroy succeeded. Starting remote backend cleanup...${NC}"

              # Extrai a Key EXATA e a Tabela do DynamoDB que o Terraform está usando
              if [ -f ".terraform/terraform.tfstate" ]; then
                  S3_EXACT_KEY=$(jq -r '.backend.config.key // empty' .terraform/terraform.tfstate)
                  DYNAMODB_TABLE=$(jq -r '.backend.config.dynamodb_table // empty' .terraform/terraform.tfstate)

                  if [ -n "$BACKEND_BUCKET" ] && [ -n "$S3_EXACT_KEY" ]; then
                      # 1. REMOVE DO S3 (Para a lógica de HEAD request do Struct8 funcionar)
                      echo -e "${color}🗑️ ${label} Deleting object: s3://${BACKEND_BUCKET}/${S3_EXACT_KEY}${NC}"
                      aws s3 rm "s3://${BACKEND_BUCKET}/${S3_EXACT_KEY}" --profile backend || echo "⚠️ Warning: failed to delete the object in S3."

                      # 2. REMOVE DO DYNAMODB (Para o Terraform não quebrar no próximo Apply)
                      if [ -n "$DYNAMODB_TABLE" ] && [ "$DYNAMODB_TABLE" != "null" ]; then
                          echo -e "${color}🔓 ${label} Removing the DynamoDB lock (table: ${DYNAMODB_TABLE})...${NC}"

                          # >>> NOVO — o LockID real do Terraform é "<bucket>/<key>" (SEM sufixo).
                          # O "-md5" abaixo é só o cache de checksum de consistência do S3, não é
                          # o lock em si — por isso apagamos os dois agora, não só o -md5.
                          aws dynamodb delete-item \
                              --table-name "$DYNAMODB_TABLE" \
                              --key "{\"LockID\": {\"S\": \"${BACKEND_BUCKET}/${S3_EXACT_KEY}\"}}" \
                              --region "$BACKEND_REGION" \
                              --profile backend || echo "⚠️ Warning: failed to delete the real lock (or it was already gone)."

                          # O padrão de LockID do Terraform no S3 é sempre: <bucket>/<key>-md5
                          LOCK_ID="${BACKEND_BUCKET}/${S3_EXACT_KEY}-md5"

                          aws dynamodb delete-item \
                              --table-name "$DYNAMODB_TABLE" \
                              --key "{\"LockID\": {\"S\": \"$LOCK_ID\"}}" \
                              --region "$BACKEND_REGION" \
                              --profile backend || echo "⚠️ Warning: failed to delete the DynamoDB item, or it no longer existed."
                      fi
                  else
                      echo -e "${color}⚠️ ${label} Bucket or key not found. Remote state kept.${NC}"
                  fi
              else
                   echo -e "${color}⚠️ ${label} Terraform cache file missing. Remote state kept.${NC}"
              fi

              # 3. Limpar arquivos locais
              echo -e "${color}🧹 ${label} Removing the local terraform cache...${NC}"
              rm -rf .terraform terraform.tfstate terraform.tfstate.backup .terraform.lock.hcl
          else
              echo -e "${color}❌ ${label} Terraform destroy failed. Remote cleanup was NOT performed.${NC}"
              return $DESTROY_STATUS
          fi
        fi
    )

    return $?
}
# ==============================================================================
# MAIN
# ==============================================================================

# RESGATANDO O CAMINHO SALVO NA MEMÓRIA DO PASSO 1
# (chega por env: MANIFEST_PATH_INPUT — ver nota no env: do step)
MANIFEST_PATH="$MANIFEST_PATH_INPUT"

# LOG CLARO PARA DEPURAÇÃO
echo "========================================================="
echo "📂 [PATH] MANIFEST RECOVERED FOR EXECUTION:"
echo "Path: $MANIFEST_PATH"
echo "========================================================="

if [ -z "$MANIFEST_PATH" ] || [ ! -f "$MANIFEST_PATH" ]; then
  echo "❌ Critical error: the manifest.json path was lost between steps, or the file is gone."
  exit 1
fi

ACTION=$(jq -r '.action // "apply"' "$MANIFEST_PATH")

# Exporta para ser visível dentro do subshell do terraform init
export BACKEND_ROLE=$(jq -r '.backend_global_config.role_arn' "$MANIFEST_PATH")
export BACKEND_REGION=$(jq -r '.backend_global_config.region' "$MANIFEST_PATH")
export BACKEND_BUCKET=$(jq -r '.backend_global_config.bucket // empty' "$MANIFEST_PATH")

# >>> NOVO — quem disparou, pro RoleSessionName (= coluna "User name" do
# CloudTrail). Ver o bloco grande em scripts/auth/aws.sh. O `// empty`
# importa: manifesto gerado antes deste campo existir devolve string
# vazia e o aws.sh cai no $GITHUB_ACTOR sozinho. `export` é obrigatório
# porque o auth do TARGET roda lá dentro do laço de estágios.
export CLOUDMAN_TRIGGERED_BY=$(jq -r '.triggered_by // empty' "$MANIFEST_PATH")

echo "⚡ Global action: $ACTION"
echo "👤 Triggered by: ${CLOUDMAN_TRIGGERED_BY:-(no field in the manifest -- falling back to $GITHUB_ACTOR)}"
echo "🔑 Setting up the backend profile..."

# Cria o profile [backend] em ~/.aws/credentials
auth_aws "{\"role_arn\": \"$BACKEND_ROLE\", \"region\": \"$BACKEND_REGION\"}" "backend"
debug_auth_status "BACKEND PROFILE CRIADO"

# ---------------------------------------------------------
# DEPENDÊNCIAS EXTERNAS
# ---------------------------------------------------------
EXTERNAL_REPOS=$(jq -c '.external_repositories // []' "$MANIFEST_PATH")
# THE CLONE TOKEN NEVER TOUCHES THE URL, SO IT NEVER LANDS IN .git/config.
#
# Until 2026-09-04 the URL was https://x-access-token:<token>@github.com/...,
# and `git clone` writes its URL to remote.origin.url -- the token stayed on the
# runner's disk, in every external checkout, for the rest of the run, readable
# by anything that could read a file (a `local-exec`, a provider). The
# credential now reaches git through its environment instead: GIT_CONFIG_* is
# read by EVERY git invocation in the loop -- clone, sparse-checkout, checkout,
# fetch, pull, and the on-demand blob fetches a --filter=blob:none clone makes
# at checkout time -- and is written nowhere. Same header actions/checkout
# uses; base64 of `x-access-token:<token>`, as GitHub's basic auth wants it.
#
# Exported BEFORE the loop because the loop runs behind a pipe, in a subshell;
# dropped right after it, in this shell, so terraform and the providers that
# run later do not inherit it either (see the SECRETS_CONTEXT block at the top).
if [ -n "${GH_CLONE_TOKEN:-}" ]; then
    export GIT_CONFIG_COUNT=1
    export GIT_CONFIG_KEY_0="http.https://github.com/.extraheader"
    export GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$GH_CLONE_TOKEN" | base64 | tr -d '\n')"
    export GIT_TERMINAL_PROMPT=0
fi

if [ "$EXTERNAL_REPOS" != "[]" ] && [ "$EXTERNAL_REPOS" != "null" ]; then
    echo "📦 Resolving external dependencies..."
    echo "$EXTERNAL_REPOS" | jq -c '.[]' | while read -r repo; do
        REPO_NAME=$(echo "$repo" | jq -r '.repo_name')
        ORG=$(echo "$repo" | jq -r '.org')
        BRANCH=$(echo "$repo" | jq -r '.branch')
        TARGET_DIR=$(echo "$repo" | jq -r '.target_dir')
        FOLDERS=$(echo "$repo" | jq -r '.folders | join(" ")')
        FULL_TARGET_DIR="./$TARGET_DIR"
        REPO_URL="https://github.com/${ORG}/${REPO_NAME}.git"

        if [ ! -d "$FULL_TARGET_DIR" ]; then
            echo "⬇️  Starting sparse checkout of $ORG/$REPO_NAME..."
            git clone --depth 1 -b "$BRANCH" --filter=blob:none --no-checkout "$REPO_URL" "$FULL_TARGET_DIR"
            cd "$FULL_TARGET_DIR"
            git sparse-checkout init --cone
            git sparse-checkout set $FOLDERS
            git checkout "$BRANCH"
            cd - > /dev/null
        else
            echo "🔄 Updating folders in $REPO_NAME..."
            (cd "$FULL_TARGET_DIR" && git sparse-checkout set $FOLDERS && git pull origin "$BRANCH")
        fi
    done
fi
unset GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0 GIT_TERMINAL_PROMPT

# The property this block promises, checked rather than assumed: no .git/config
# written during the clones carries the token. `-F` and the value itself, so a
# future edit that puts it back in a URL, in any spelling, fails here and not in
# an audit. The value is never printed.
if [ -n "${GH_CLONE_TOKEN:-}" ]; then
    if find . -name .terraform -prune -o -path '*/.git/config' -type f -print0 2>/dev/null \
        | xargs -0 -r grep -lF -- "$GH_CLONE_TOKEN" 2>/dev/null | grep -q .; then
        echo "::error::The clone token was written to a .git/config on the runner. Refusing to continue."
        exit 1
    fi
    echo "🔒 Clone credential kept out of every .git/config."
fi

# ---------------------------------------------------------
# EXECUÇÃO DOS ESTÁGIOS
# ---------------------------------------------------------
TOTAL_STAGES=$(jq '.pipeline_stages | length' "$MANIFEST_PATH")

for (( i=0; i<$TOTAL_STAGES; i++ )); do
    STAGE_NAME=$(jq -r ".pipeline_stages[$i].stage_name" "$MANIFEST_PATH")
    IS_PARALLEL=$(jq -r ".pipeline_stages[$i].parallel_execution" "$MANIFEST_PATH")
    STATES_JSON=$(jq -c ".pipeline_stages[$i].states[]" "$MANIFEST_PATH")

    # >>> NÃO usar "::group::" aqui. O `::group::` renderiza a seção RECOLHIDA
    # por padrão no painel do Actions — como todo o terraform (init/plan/apply/
    # destroy) rodava dentro dele, o log ficava escondido atrás de uma dobra
    # fechada durante TODA a execução. Em stage curto o grupo fechava rápido e
    # dava a impressão de funcionar; em stage longo (EKS, minutos) nunca
    # aparecia nada ao vivo — exatamente quando mais se precisa acompanhar.
    # Separador simples = output sempre visível, sem depender de dobra.
    echo ""
    echo "=========================================================="
    echo "🚀 Stage: $STAGE_NAME"
    echo "=========================================================="

    pids=""
    failed=0

    while read -r state; do
        path=$(echo "$state" | jq -r '.path')
        provider=$(echo "$state" | jq -r '.provider')
        target_auth=$(echo "$state" | jq -c '.target_auth')
        # `// []` cobre o manifesto antigo, que não traz o campo.
        additional_auth=$(echo "$state" | jq -c '.additional_auth // []')

        if [ ! -d "$path" ]; then
             echo "⚠️  Directory $path does not exist. Skipping."
             continue
        fi
        if [ -d ".external_modules" ]; then
            ln -sfn "$(readlink -f .external_modules)" "$path/.external_modules"
        fi

        if [ "$IS_PARALLEL" == "true" ]; then
            run_terraform_process "$path" "$ACTION" "$target_auth" "$provider" "$additional_auth" &
            pids="$pids $!"
        else
            run_terraform_process "$path" "$ACTION" "$target_auth" "$provider" "$additional_auth"
            if [ $? -ne 0 ]; then failed=1; break; fi
        fi
    done <<< "$STATES_JSON"

    if [ "$IS_PARALLEL" == "true" ]; then
        for pid in $pids; do
            wait $pid
            if [ $? -ne 0 ]; then failed=1; fi
        done
    fi

    if [ $failed -ne 0 ]; then
        echo "::error::Stage $STAGE_NAME failed"
        exit 1
    fi

    echo "✅ Stage finished: $STAGE_NAME"
done
