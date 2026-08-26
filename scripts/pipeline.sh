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

# ==============================================================================
# CONFIGURAÇÕES E CORES
# ==============================================================================
# -e e -o pipefail reproduzem EXATAMENTE o shell que o Actions usava quando
# este script vivia dentro do bloco run: (bash --noprofile --norc -e -o
# pipefail). Sem o -e aqui, comando que falha deixaria de abortar o step e a
# mudanca de arquivo teria alterado a semantica de falha do pipeline inteiro.
set -eo pipefail
export LC_ALL=C.UTF-8   # >>> NOVO — garante que `grep -P` (usado no backstop de lock) funcione, independente do locale padrão do runner

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
# Credencial efêmera de escrita no R2. Sourced, e não só presente na pasta:
# `cloudflare.sh` define auth_cloudflare() e ninguém o carrega -- a
# autenticação da Cloudflare que ROLA de verdade é o bloco inline mais abaixo.
# Editar aquele arquivo achando que ele participa do fluxo não muda nada.
source "$AUTH_SCRIPTS/r2.sh"

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
    local status=0 lock_id who_str owner_run_id run_status
    local logfile="./.struct8-live.log"

    # `|| status=$?`, e não `_stream_cmd` solto seguido de `status=$?`: com o
    # `set -eo pipefail` da linha 27, um comando que falha fora de uma condição
    # derruba o shell NA HORA. A linha do `status=$?` nunca chegava a rodar com
    # valor diferente de zero, e portanto TODO o resto desta função -- a
    # recuperação de lock travado inteira -- era código inalcançável. Medido num
    # shell isolado com esta mesma estrutura (função -> pipeline -> `return
    # ${PIPESTATUS[0]}` -> subshell), não deduzido: com o comando falhando, nada
    # abaixo dele imprime; com o comando passando, tudo imprime.
    _stream_cmd "$@" || status=$?

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
            status=0
            _stream_cmd "$@" || status=$?
        else
            echo "⏳ Run #$owner_run_id is still '$run_status' -- the lock is real and active. Leaving it alone."
        fi
    fi

    return $status
}

# ==============================================================================
# Hands a file to the workflow's publish step.
#
# WHY THIS INDIRECTION EXISTS
#
# The workflow uploads whatever lands in this directory, without knowing what any
# of it is. That matters because `engine.yml` is ONE file shared by every channel
# and every customer, while this script is checked out per channel -- so anything
# encoded in the workflow can only change for everyone at once. Publishing a new
# kind of file later is a change here, in the channel being developed, and never
# a change there.
#
# WHY THE NAME CARRIES THE FOLDER
#
# The archive cannot: upload-artifact roots it at the common ancestor of what it
# matched, which for a single state IS that state's folder -- so the folder name,
# the only thing saying WHICH state a file belongs to, would be gone. Encoding it
# in the filename puts it somewhere the archive cannot drop. The reader rebuilds
# the same name; see `artifact_entry_name` in AgentV2.
# ==============================================================================
publish_engine_artifact() {
    local src_dir="$1" file="$2"
    local out="${RUNNER_TEMP:-/tmp}/struct8-artifacts"

    local flat="${src_dir#./}"
    flat="${flat%/}"
    # A state at the repository root has no folder to name it after; `_root`
    # keeps the name well-formed instead of producing a leading dot.
    if [ -z "$flat" ] || [ "$flat" = "." ]; then
        flat="_root"
    else
        flat="${flat//\//__}"
    fi

    mkdir -p "$out"
    cp "$file" "$out/${flat}.${file}"
}

# ==============================================================================
# Publica o MOTIVO de um plan que não produziu resultado.
#
# POR QUE O ARQUIVO DE FALHA TEM O MESMO NOME DO DE SUCESSO
#
# Quem lê (`get_plan_result_from_artifact`, no AgentV2) procura a entrada
# `<pasta>.plan_result.json.gz` e, não encontrando, VOLTA até 5 artefatos e
# devolve a primeira que encontrar. Uma execução que falha sem publicar nada não
# produz "ainda não há resultado" no diagrama: produz o plano da execução
# ANTERIOR, entregue como se fosse a resposta de agora. Publicar a falha sob o
# mesmo nome é o que interrompe essa varredura. Um nome novo não interromperia --
# deixaria o sucesso velho no caminho e ainda exigiria mudança no leitor.
#
# O QUE VAI NA MENSAGEM, E O QUE NÃO VAI
#
# Só o bloco de erro do próprio Terraform (a caixa que começa em `╷`), limitado a
# 60 linhas; sem caixa nenhuma, as últimas 40 linhas do log. O log INTEIRO fica
# de fora de propósito: este arquivo é legível por quem lê as Actions do
# repositório, e o log carrega tudo o que o comando imprimiu antes de falhar.
# Isso reduz a exposição, não a elimina -- o bloco de erro pode citar valor de
# atributo, porque é o Terraform que escolhe o que mostrar ali.
#
# A execução continua falhando como antes. Este arquivo não é um jeito de a falha
# passar: é o que conta ao diagrama que ela aconteceu.
# ==============================================================================
publish_plan_failure() {
    local src_dir="$1" stage="$2" logfile="$3"
    local message=""

    if [ -n "$logfile" ] && [ -f "$logfile" ]; then
        # Da primeira marca de erro até o fim. `head -n`, e não `head -c`: cortar
        # por byte parte caractere UTF-8 no meio, e o que sobra não é texto.
        message=$(awk '/^╷/ || /Error:/ { found = 1 } found' "$logfile" | head -n 60)
        if [ -z "$message" ]; then
            message=$(tail -n 40 "$logfile")
        fi
    fi

    # Os mesmos campos que o front-end já lê no arquivo de sucesso, com os dois
    # arrays vazios -- sem eles o explicador avisa "o plano não tem
    # resource_changes", que é verdade e não é a informação. `timestamp` é a hora
    # da FALHA: é dela que sai a tarja de idade, e é o que distingue esta leitura
    # de um plano velho.
    if jq -n \
        --arg stage "$stage" \
        --arg message "$message" \
        --arg run_url "${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}" \
        --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        '{
            timestamp:        $ts,
            cloudman_error:   { stage: $stage, message: $message, run_url: $run_url },
            resource_changes: [],
            resource_drift:   []
        }' > plan_result.json && gzip -9 -f plan_result.json; then
        publish_engine_artifact "$src_dir" plan_result.json.gz
        echo -e "${YELLOW}📄 [${src_dir}] plan_result.json.gz published with the failure reason (stage: ${stage}).${NC}"
    else
        # Dentro de um `if` de propósito: uma falha AQUI não pode derrubar o
        # shell, senão o passo que só avisava passaria a interromper a execução.
        echo -e "${RED}❌ [${src_dir}] Could not write the plan failure file.${NC}"
    fi

    rm -f plan_result.json plan_result.json.gz
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

        # O ARQUIVO QUE UMA FUNCAO IMPORTADA APONTA.
        #
        # `aws_lambda_function` exige em configuracao um de `filename`,
        # `image_uri` ou `s3_bucket`, e uma funcao importada nao responde por
        # nenhum: a AWS devolve uma URL assinada para baixar o pacote atual,
        # nunca de onde ele veio. O diagrama entao declara um arquivo
        # provisorio e ignora ele e o hash que sai dele -- o codigo continua
        # sendo o que ja esta rodando, e o Terraform cuida so das
        # configuracoes da funcao.
        #
        # O provider abre esse arquivo para calcular o hash, mesmo com
        # `ignore_changes`. Ele nao vai para o repositorio de proposito: e um
        # ZIP vazio de 22 bytes, sem conteudo nenhum, e commita-lo seria
        # guardar um artefato que ninguem le. Escrito aqui, uma vez por
        # execucao, so quando a configuracao o menciona.
        if grep -rqs "imported_lambda_placeholder.zip" --include="*.tf" . 2>/dev/null; then
            if [ ! -f "imported_lambda_placeholder.zip" ]; then
                printf 'PK\005\006\000\000\000\000\000\000\000\000\000\000\000\000\000\000\000\000\000\000' \
                    > imported_lambda_placeholder.zip
                echo -e "${color}   wrote the placeholder archive an imported function points at${NC}"
            fi
        fi

        # Limpa ambiente para garantir que o Init use apenas o profile
        unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_REGION

        # SOLUÇÃO DO PROBLEMA DE LOCK:
        # Injetamos '-backend-config="profile=backend"'
        # Isso força o Terraform a salvar no .terraform/terraform.tfstate que
        # ele DEVE usar o profile 'backend' para operações de estado (S3/Dynamo),
        # ignorando as variáveis de ambiente que vamos carregar no passo 2.

        # Via `_stream_cmd` pelo mesmo motivo que o plan: é ele que grava o log
        # de onde a mensagem de erro é lida. Sem isso, um init que falha por
        # credencial ou backend chegava ao diagrama como plano velho, igual a
        # todas as outras falhas.
        INIT_STATUS=0
        if [ "$action" == "scan" ]; then
            # A scan is not Terraform. Its folder holds the manifest and the
            # scope and no `.tf` at all, so there is no configuration for init
            # to initialise. It also neither reads nor writes state, which is
            # what makes it the one action here that does not need the backend.
            echo -e "${color}⏭️  ${label} Scan: no Terraform in this folder, skipping init.${NC}"
        else
            _stream_cmd terraform init -reconfigure -input=false \
                -backend-config="profile=backend" \
                -backend-config="region=$BACKEND_REGION" || INIT_STATUS=$?
        fi

        if [ $INIT_STATUS -ne 0 ]; then
            # Só plan e drift: é o arquivo que ESSAS duas ações publicam e que o
            # diagrama lê. Publicá-lo a partir de um apply faria a próxima
            # leitura de plan atribuir a um plan uma falha que não foi dele.
            if [ "$action" == "plan" ] || [ "$action" == "drift" ]; then
                publish_plan_failure "$path" init "./.struct8-live.log"
            fi
            exit $INIT_STATUS
        fi

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

            # Escrever OBJETO no R2 não passa por este token: o conteúdo entra
            # pelo endpoint S3 da conta, que só aceita assinatura SigV4. Quando
            # o HCL gerado pede esse par, ele é cunhado agora, vive alguns
            # minutos e é revogado pelo trap -- ver scripts/auth/r2.sh.
            #
            # O trap é armado ANTES do mint, e não depois: uma falha no meio da
            # criação já pode ter deixado o token de pé na conta.
            if r2_state_needs_credentials; then
                trap r2_revoke_ephemeral_credentials EXIT
                r2_mint_ephemeral_credentials "$(echo "$auth_json" | jq -r '.account_id')" "$label"
                r2_verify_credentials "$(echo "$auth_json" | jq -r '.account_id')"
            fi
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

                # AWS não tem secret: a conta estrangeira é alcançada pelo MESMO
                # OIDC do GitHub que este state já usa na conta dele, assumindo na
                # outra conta a role Struct8-Gitops-{org}-{repo}. Sai daqui um
                # profile nomeado `acct_<id>`, que é exatamente o nome que o
                # `provider "aws"` aliasado do HCL procura -- os dois lados têm que
                # concordar nessa string, então mudar o formato aqui exige mudar
                # registerAccountProviderAlias no gerador AWS junto.
                #
                # Este ramo sai ANTES da busca de secret de propósito: passar por
                # ela procuraria AUTH_AWS_<conta> no SECRETS_CONTEXT e abortaria o
                # apply por uma secret que não existe nem deveria existir.
                if [ "$extra_provider" == "aws" ]; then
                    local extra_role=$(echo "$extra" | jq -r '.role_arn // empty')
                    local extra_acct=$(echo "$extra" | jq -r '.account_id // empty')
                    local extra_region=$(echo "$extra" | jq -r '.region // "us-east-1"')

                    if [ -z "$extra_role" ] || [ -z "$extra_acct" ]; then
                        echo "❌ Error: additional AWS credential without role_arn/account_id (required by $path)."
                        exit 1
                    fi

                    echo "🔑 Additional credential (aws): account $extra_acct -> profile acct_${extra_acct}"
                    auth_aws "{\"role_arn\": \"$extra_role\", \"region\": \"$extra_region\"}" "acct_${extra_acct}"

                    # Confere que o profile ficou utilizável, em vez de deixar o
                    # terraform descobrir depois. `auth_aws` monta as credenciais
                    # com `local creds=$(aws sts ...)`, e o `local` MASCARA o
                    # código de saída: um assume-role recusado não aborta nada --
                    # o jq extrai vazio e o profile é gravado sem chave nenhuma.
                    # Sem esta conferência, a falha mais provável deste caminho (a
                    # conta destino ainda não conectada ao workspace) chegaria ao
                    # usuário como um erro do provider AWS, sem dizer qual conta.
                    if ! aws sts get-caller-identity --profile "acct_${extra_acct}" > /dev/null 2>&1; then
                        echo "❌ Error: could not sign in to AWS account $extra_acct as $extra_role (required by $path)."
                        echo "   Connect that account to this GitOps workspace before deploying a state that uses resources in it."
                        exit 1
                    fi
                    continue
                fi

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

        if [ "$action" == "plan" ] || [ "$action" == "drift" ]; then
          # `drift` roda o MESMO plan, com uma pergunta diferente: -refresh-only
          # compara o state com a nuvem e ignora o que o código pede, então o que
          # sai é só o que mudou por fora. Sem ele, o plano responde as duas
          # coisas de uma vez e não dá pra separar quem causou o quê.
          PLAN_EXTRA_FLAGS=""
          if [ "$action" == "drift" ]; then
            PLAN_EXTRA_FLAGS="-refresh-only"
          fi

          # -out grava o plano num arquivo pra ele poder ser relido como JSON.
          # NÃO usar -detailed-exitcode: ele faz "há mudanças" virar exit 2, o que
          # marcaria como FALHA todo plan que encontrasse algo -- exatamente o caso
          # normal. O comportamento de saída do plan continua o de antes.
          #
          # `|| PLAN_STATUS=$?` é o que torna a falha CAPTURÁVEL -- ver a mesma
          # correção em run_tf_with_stale_lock_recovery. Antes disto o shell
          # morria no plan que falhava e a linha abaixo nunca via valor diferente
          # de zero.
          PLAN_STATUS=0
          run_tf_with_stale_lock_recovery terraform plan -input=false $PLAN_EXTRA_FLAGS -out=cloudman.tfplan || PLAN_STATUS=$?

          if [ $PLAN_STATUS -eq 0 ] && [ -f "cloudman.tfplan" ]; then
            echo -e "${color}📄 ${label} Converting the plan to JSON for the front end...${NC}"

            # stderr num arquivo, e não em /dev/null: é a única cópia da razão
            # pela qual a conversão falhou, e sem ela o diagrama receberia um
            # aviso sem o motivo. Continua fora do console, como antes.
            if terraform show -json cloudman.tfplan > cloudman.plan.raw.json 2>./.struct8-show.log; then
              # ---------------------------------------------------------------
              # REDAÇÃO — roda ANTES de qualquer commit, e é o motivo deste bloco
              # existir. `terraform show -json` NÃO mascara valor sensível: ele
              # entrega o valor e apenas o SINALIZA em before_sensitive/
              # after_sensitive. Como este arquivo é commitado no repositório do
              # cliente, gravá-lo cru colocaria segredo no histórico do git, onde
              # apagar depois não resolve.
              #
              # Duas defesas somadas:
              # 1. Só sobrevivem os campos que o front-end lê. prior_state,
              #    planned_values e configuration carregam o estado inteiro da
              #    infraestrutura -- some com eles corta a maior parte da
              #    exposição de uma vez.
              #
              #    `timestamp` é um dos que o front-end lê, e a lista fechada o
              #    estava derrubando: é a hora em que o Terraform CRIOU o plano, e
              #    dela sai a tarja de idade no diagrama ("Plan há 2 horas"). Sem
              #    ela o diagrama não tem como dizer o quanto a leitura de drift
              #    envelheceu -- e a hora em que alguém baixou o arquivo não
              #    responde isso, pode haver dias entre as duas. Escalar, não
              #    carrega nada da infraestrutura: entra sem custo de exposição.
              #
              #    RESSALVA sobre prior_state, que continua fora: o front-end
              #    passou a consumi-lo. `driftClassifier` lê dali os
              #    `aws_security_group_rule` que este diagrama declara, para não
              #    acusar como drift uma regra que a nuvem só espelha. Sem ele a
              #    separação não acontece, e a aba Plan avisa disso em vez de
              #    classificar errado. Devolver prior_state inteiro NÃO é a saída
              #    -- seria republicar o estado completo, que é justamente o que
              #    esta defesa corta. O que caberia é projetar dali só esses
              #    recursos de regra.
              # 2. Toda folha marcada como sensível vira "__REDACTED__", em
              #    before e after, incluindo dentro de bloco aninhado e lista.
              #
              # LIMITE 1 (alcance): isto cobre o que o PROVIDER marcou como
              # sensível. Segredo guardado num campo comum (ex.: senha colada num
              # user_data) não é sinalizado por ninguém e passa. Nenhuma redação
              # genérica resolve isso -- quem escreve segredo em campo comum
              # precisa de sensitive/Secrets Manager.
              #
              # LIMITE 2 (fidelidade): os dois lados recebem o MESMO marcador,
              # então uma mudança que acontece só dentro de campo sensível fica
              # indistinguível de "não mudou" para quem lê o arquivo depois --
              # uma troca de senha não aparece como alteração. Preservar esse
              # sinal exigiria percorrer before/after em paralelo e marcar os
              # lados de forma diferente quando divergem. Fica em aberto de
              # propósito: hoje o diagrama só desenha o badge por recurso e não
              # renderiza diferença campo-a-campo, então nada é perdido na tela.
              # Quem for exibir campo-a-campo precisa resolver isto ANTES, senão
              # a tela afirma "sem alteração" sobre algo que não sabe.
              # ---------------------------------------------------------------
              #
              # WHY IT IS PUBLISHED COMPRESSED
              #
              # The reader is the diagram, never a human browsing the repository,
              # and it goes through GitHub's contents API -- which returns an
              # EMPTY body for files over 1 MB. That limit is silent: the caller
              # gets HTTP 200 with no content and reports "the plan is not ready
              # yet", so a plan too big to fetch is indistinguishable from a run
              # still in flight. Real captures are already 150-300 KB, so gzip
              # (~15x on plan JSON) moves the ceiling far enough out to stop
              # being a concern, and shrinks what the client's history carries
              # by the same factor.
              #
              # `&&` and not a pipe: in a pipeline the exit status is gzip's, so
              # `jq` failing to redact would be masked and the guard below --
              # which exists to never publish unredacted values -- would never
              # fire. Keeping them as separate commands keeps jq's status.
              if jq -e '
                def redact($val; $sens):
                  if $sens == true then "__REDACTED__"
                  elif ($sens | type) == "object" and ($val | type) == "object" then
                    reduce ($val | keys_unsorted[]) as $k
                      ({}; .[$k] = redact($val[$k]; ($sens[$k] // false)))
                  elif ($sens | type) == "array" and ($val | type) == "array" then
                    [ range(0; $val | length) as $i
                      | redact($val[$i]; (($sens[$i]) // false)) ]
                  else $val
                  end;

                def redact_change:
                  .before = redact(.before; (.before_sensitive // false))
                  | .after = redact(.after; (.after_sensitive // false));

                {
                  format_version:    .format_version,
                  terraform_version: .terraform_version,
                  timestamp:         .timestamp,
                  resource_changes:  [ (.resource_changes // [])[] | .change |= redact_change ],
                  resource_drift:    [ (.resource_drift   // [])[] | .change |= redact_change ]
                }
              ' cloudman.plan.raw.json > plan_result.json && gzip -9 -f plan_result.json; then
                echo -e "${color}✅ ${label} plan_result.json.gz ready (sensitive values redacted).${NC}"
                # Nothing here reaches the customer's repository. The file is
                # handed to the workflow's publish step instead, which uploads it
                # without knowing what it is.
                publish_engine_artifact "$path" plan_result.json.gz
              else
                # Sem redação confiável, NADA é publicado. Falhar de forma visível
                # é preferível a publicar um arquivo que pode conter segredo.
                echo -e "${RED}❌ ${label} Could not redact the plan JSON; refusing to publish it.${NC}"
                rm -f plan_result.json plan_result.json.gz
                # Sem log: a falha é da própria redação, e a saída do jq não
                # diria nada ao usuário. O estágio é a informação inteira -- o
                # plano rodou e não foi publicado por segurança.
                publish_plan_failure "$path" redact ""
              fi
            else
              echo -e "${YELLOW}⚠️ ${label} Could not convert the plan to JSON. The plan itself ran fine.${NC}"
              publish_plan_failure "$path" show "./.struct8-show.log"
            fi
          elif [ $PLAN_STATUS -ne 0 ]; then
            echo -e "${RED}❌ ${label} terraform plan failed.${NC}"
            publish_plan_failure "$path" plan "./.struct8-live.log"
          else
            # Saiu zero e não deixou o arquivo do plano. Sem log: o `awk` não
            # acharia marca de erro nenhuma num plan que passou, e cairia nas
            # últimas linhas de uma saída bem-sucedida -- texto que não explica
            # nada a quem lê. O estágio sozinho diz mais.
            echo -e "${RED}❌ ${label} terraform plan reported success but wrote no plan file.${NC}"
            publish_plan_failure "$path" plan ""
          fi

          # O .tfplan e o JSON cru carregam os valores NÃO redigidos. Somem sempre,
          # inclusive quando algum passo acima falhou, pra não sobrar no workspace
          # nem serem varridos por um `git add` de outro step.
          rm -f cloudman.tfplan cloudman.plan.raw.json .struct8-show.log

          # A execução continua falhando como antes -- publicar o motivo não é um
          # jeito de a falha passar. Sai DEPOIS do rm acima, senão o .tfplan não
          # redigido ficaria no workspace.
          if [ $PLAN_STATUS -ne 0 ]; then exit $PLAN_STATUS; fi

        elif [ "$action" == "apply" ]; then
          echo -e "${color}▶️ ${label} Running terraform apply...${NC}"
          run_tf_with_stale_lock_recovery terraform apply -auto-approve -input=false
          APPLY_STATUS=$?

        # INÍCIO DA NOVA LÓGICA DE IMPORT (GERAÇÃO PARA REVISÃO)
        # TWO NAMES, ONE PASS. `import` is the original name and the old Import
        # tab still sends it. `read` is what the account-scan journey sends, and
        # it is the accurate one: this branch WRITES NO STATE -- it reads the
        # resources named in the import blocks and produces a draft. The step
        # that writes is `apply`, over those same blocks.
        elif [ "$action" == "import" ] || [ "$action" == "read" ]; then
          echo -e "${color}📥 ${label} Generating import draft...${NC}"

          # 1. Limpeza preventiva absoluta
          rm -f generated_resources.tf generated_resources.tf.prev import.tfplan generated_resources.json draft_plan.log draft_plan.json

          # 2. Executa a geração. O gerador de configuração é experimental e a
          # saída dele quase sempre tem conflito de HCL, então a falha aqui é
          # esperada e tratada no passo 2b -- não é motivo para derrubar o
          # pipeline. O log vai para arquivo porque 2b precisa lê-lo.
          DRAFT_STATUS=0
          terraform plan -generate-config-out=generated_resources.tf -out=import.tfplan -input=false > draft_plan.log 2>&1 || DRAFT_STATUS=$?
          cat draft_plan.log

          # 2a. OS BLOCOS DE IMPORT VÊM DE UMA VARREDURA, E UMA VARREDURA É UMA
          # FOTO. Entre a pessoa escolher os recursos e a importação rodar, algo
          # pode ter sido apagado -- e o Terraform então para. Não aquele
          # recurso: a rodada inteira. Uma instância que sumiu derruba o
          # rascunho das outras onze.
          #
          # Tirar o bloco não esconde a diferença: sobram menos recursos do que
          # os pedidos, e o canvas compara os dois números e para nisso. A
          # configuração é regerada do zero porque ela foi escrita com o recurso
          # que não existe mais.
          PRUNER="$ENGINE_PATH/scripts/prune-missing-imports.mjs"
          if [ "$DRAFT_STATUS" -ne 0 ] && [ -f "$PRUNER" ] && [ -f imports.tf ] && command -v node > /dev/null 2>&1; then
            for round in 1 2; do
              grep -q 'Cannot import non-existent remote object' draft_plan.log || break
              node "$PRUNER" imports.tf draft_plan.log || break
              echo -e "${YELLOW}⚠️ Some of the resources picked no longer exist in the account, and were left out of the draft.${NC}"
              rm -f generated_resources.tf
              DRAFT_STATUS=0
              terraform plan -generate-config-out=generated_resources.tf -out=import.tfplan -input=false > draft_plan.log 2>&1 || DRAFT_STATUS=$?
              cat draft_plan.log
              if [ "$DRAFT_STATUS" -eq 0 ]; then break; fi
            done
          fi

          # 2b. O RASCUNHO SÓ SERVE SE O ARQUIVO DE PLANO FOR ESCRITO. Sem ele
          # não há JSON, e o que chega ao front-end é o aviso do passo 3 -- que
          # se lê como "não achei nada" e não como "isto falhou".
          #
          # O que trava o plano é o próprio gerador emitindo cada atributo
          # opcional do schema no valor zero (`ipv6_cidr_block = ""`,
          # `enable_lni_at_device_index = 0`), que os validadores do provider
          # então recusam. Medido numa VPC de 12 recursos no provider 5.100.0:
          # 10 erros e nenhum plano. `sanitize-generated-config.mjs` tira esses
          # valores; cada rodada recebe os erros do plano anterior e a série
          # para assim que não houver mais o que tirar.
          if [ "$DRAFT_STATUS" -ne 0 ] && [ -f "generated_resources.tf" ]; then
            SANITIZER="$ENGINE_PATH/scripts/sanitize-generated-config.mjs"
            if [ ! -f "$SANITIZER" ] || ! command -v node > /dev/null 2>&1; then
              echo -e "${YELLOW}⚠️ Warning: the draft has HCL errors and cannot be repaired here (node or the sanitizer is missing).${NC}"
            else
              echo -e "${color}🧹 ${label} Repairing the generated HCL...${NC}"

              # ANTES DA PASSAGEM 1, e a ordem e o ponto todo.
              #
              # `aws_lambda_function` exige em configuracao um de `filename`,
              # `image_uri` ou `s3_bucket`, e a AWS nao responde por nenhum
              # deles: ela devolve uma URL assinada para baixar o pacote atual,
              # nunca de onde ele foi enviado. O gerador escreve os tres na
              # string vazia, a passagem 1 limpa os tres por estarem vazios, e
              # dai em diante nao ha mais o que completar -- so o provider
              # dizendo que falta um, sobre uma funcao que esta rodando.
              #
              # Medido em 2026-08-26 numa conta de cinco recursos: o plano
              # fechou em `3 to import` e a funcao foi uma das duas de fora.
              COMPLETER="$ENGINE_PATH/scripts/complete-lambda-source.mjs"
              if [ -f "$COMPLETER" ]; then
                node "$COMPLETER" generated_resources.tf || true
              fi

              node "$SANITIZER" generated_resources.tf || true

              # O LAÇO RODA EM `terraform validate`, NÃO EM `plan`.
              #
              # É a mesma autoridade: `ConflictsWith`, `RequiredWith` e os
              # validadores de valor são checados na validação de schema do SDK,
              # que acontece ANTES de qualquer chamada de API. Medido contra os
              # seis erros desta conta, o `validate` pega todos os seis, com o
              # texto idêntico ao do plan -- e roda sem credencial nenhuma.
              #
              # A diferença é o preço de um passe. Cada `plan` relia a conta
              # inteira, o que fazia o teto de passes virar risco de verdade:
              # cortar cedo devolvia um rascunho parcial, e cortar tarde custava
              # minutos por rodada. Um `validate` não fala com a AWS, então o
              # teto pode ser alto sem custar nada.
              #
              # Quem termina a série continua sendo o saneador, que sai com 1
              # assim que não tem mais o que tirar.
              REPAIR_PASSES=0
              for attempt in 1 2 3 4 5 6 7 8 9 10 11 12; do
                if terraform validate > draft_plan.log 2>&1; then break; fi
                REPAIR_PASSES=$attempt
                node "$SANITIZER" generated_resources.tf draft_plan.log || break
              done

              # O plano volta a ser tirado UMA vez, agora que a configuração
              # passa na validação. Sem `-generate-config-out` de propósito: ele
              # recusa sobrescrever um arquivo que existe, e daqui em diante a
              # configuração É o arquivo que acabou de ser saneado.
              if terraform plan -out=import.tfplan -input=false > draft_plan.log 2>&1; then
                DRAFT_STATUS=0
                echo -e "${color}✅ Draft repaired in ${REPAIR_PASSES} local pass(es).${NC}"
              else
                cat draft_plan.log
                echo -e "${YELLOW}⚠️ Warning: the draft still has HCL errors after the repair passes.${NC}"
              fi
            fi
          fi

          # 2c. `user_data` chega ao rascunho como o SHA1 que o state guarda,
          # nunca como o conteúdo -- e o provider relê esse hash COMO SE fosse o
          # conteúdo, propondo trocar o user-data da instância pelo hash de
          # outra coisa. Remover a linha não resolve, `user_data_base64` não
          # resolve e `ignore_changes` não resolve; medido contra uma instância
          # viva, o único rascunho que fecha em `0 to change` é o que carrega o
          # script de verdade. Por isso ele é lido da conta e escrito aqui.
          if [ "$DRAFT_STATUS" -eq 0 ] && [ -f "generated_resources.tf" ]; then
            INLINER="$ENGINE_PATH/scripts/inline-user-data.mjs"
            if [ -f "$INLINER" ] && command -v node > /dev/null 2>&1 && command -v aws > /dev/null 2>&1; then
              cp generated_resources.tf generated_resources.tf.prev
              if terraform show -json import.tfplan > draft_plan.json 2>/dev/null && node "$INLINER" generated_resources.tf draft_plan.json; then
                if terraform plan -out=import.tfplan -input=false > draft_plan.log 2>&1; then
                  echo -e "${color}📝 ${label} The user-data of the imported instances is in the draft, and gets committed with it.${NC}"
                else
                  # Sem plano não há JSON, e o rascunho anterior pelo menos tinha
                  # um. A diferença de user_data volta, e é visível no plano.
                  cat draft_plan.log
                  echo -e "${YELLOW}⚠️ Warning: the draft stopped planning once the user-data was written in. Keeping the version without it.${NC}"
                  mv generated_resources.tf.prev generated_resources.tf
                  terraform plan -out=import.tfplan -input=false > draft_plan.log 2>&1 || true
                fi
              fi
              rm -f generated_resources.tf.prev draft_plan.json
            fi
          fi

          # 3. Verifica se pelo menos o arquivo .tf foi gerado (mesmo com erros de validação)
          if [ -f "generated_resources.tf" ]; then
              echo -e "${color}📄 HCL file generated. Converting it to JSON for the front end...${NC}"

              # Tenta gerar o JSON. Se falhar por erro no plano, criamos um JSON básico de sinalização
              if terraform show -json import.tfplan > generated_resources.json 2>/dev/null; then
                  echo -e "${color}✅ JSON generated successfully.${NC}"
              else
                  echo "{\"info\": \"The HCL was generated but the plan has validation errors. Review the .tf file by hand.\"}" > generated_resources.json
                  echo -e "${YELLOW}⚠️ Warning: could not generate the detailed JSON because the plan has errors.${NC}"
              fi

              echo -e "${color}⏳ ${label} Drafts are ready for review.${NC}"
              touch "$GITHUB_WORKSPACE/.needs_commit"
          else
              echo -e "${RED}❌ Critical error: terraform could not even produce the draft .tf file.${NC}"
              exit 1
          fi

        elif [ "$action" == "scan" ]; then
          echo -e "${color}🔎 ${label} Listing the account...${NC}"

          # In Node rather than bash with jq, because what comes out is a JSON
          # with two layers and what consumes it is TypeScript: keeping the shape
          # in one language is what stops the two ends from drifting apart.
          # `node` ships with the GitHub runner, but the check stays -- without
          # it the failure would surface as "the scan produced no inventory",
          # which points at the wrong thing.
          if ! command -v node > /dev/null 2>&1; then
            echo -e "${RED}❌ Critical error: node is not on this runner, and the scan needs it.${NC}"
            exit 1
          fi

          rm -f scan_inventory.json

          # No `|| true`: the script already records, inside the inventory, every
          # service the credentials could not read, and carries on. So a non-zero
          # exit means it did not reach the end -- and a partial inventory passing
          # for a complete one is the worst outcome this action has.
          node "$ENGINE_PATH/scripts/scan-account.mjs" --out scan_inventory.json

          if [ ! -f scan_inventory.json ]; then
            echo -e "${RED}❌ Critical error: the scan produced no inventory file.${NC}"
            exit 1
          fi

          SCAN_COUNT=$(jq '.items | length' scan_inventory.json 2>/dev/null || echo "?")
          SCAN_ERRORS=$(jq '.errors | length' scan_inventory.json 2>/dev/null || echo "?")
          echo -e "${color}📄 ${label} ${SCAN_COUNT} resource(s) listed, ${SCAN_ERRORS} service(s) unreadable.${NC}"

          touch "$GITHUB_WORKSPACE/.needs_scan_commit"

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

        else
          # NO SILENT FALL-THROUGH. Until this branch existed, an action the
          # engine does not know -- a typo, or a name the app began sending
          # before the engine learned it -- ran init and target auth, matched
          # nothing in this chain, and the run finished GREEN having done
          # nothing at all. The app was then left waiting for a file that was
          # never going to arrive, with no failure anywhere to point at.
          echo -e "${RED}❌ Unknown action '$action'. This engine serves: plan, drift, apply, destroy, import, read, scan.${NC}"
          exit 1
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

# WHICH CODE VERSION THIS RUN CLONED
#
# One line per source: `provider:owner/repo<TAB>identifier`. Written to a FILE
# and not to a variable because the loop below runs behind a pipe (`| while`),
# and anything a subshell assigns dies with it -- that is how the first version
# of the progress report lost its token, silently.
#
# `report_state_progress` reads it and sends the contents in the first report.
# This is where version promotion starts: the canvas stores these values on the
# stage, and the next stage receives the same ones instead of looking up the tip
# of the branch again.
SOURCES_FILE="${RUNNER_TEMP:-/tmp}/cloudman_sources.tsv"
rm -f "$SOURCES_FILE"

# Sources whose requested version did NOT end up in the tree. Also a file, for
# the same reason: `exit` inside the loop would kill only the subshell, and the
# pipeline would carry on running terraform against the wrong tree -- silently,
# which is exactly what this exists to prevent. Checked after the loop, in the
# real shell.
PIN_FAILED_FILE="${RUNNER_TEMP:-/tmp}/cloudman_pin_failed.txt"
rm -f "$PIN_FAILED_FILE"

if [ "$EXTERNAL_REPOS" != "[]" ] && [ "$EXTERNAL_REPOS" != "null" ]; then
    echo "📦 Resolving external dependencies..."
    echo "$EXTERNAL_REPOS" | jq -c '.[]' | while read -r repo; do
        REPO_NAME=$(echo "$repo" | jq -r '.repo_name')
        ORG=$(echo "$repo" | jq -r '.org')
        BRANCH=$(echo "$repo" | jq -r '.branch')
        TARGET_DIR=$(echo "$repo" | jq -r '.target_dir')
        FOLDERS=$(echo "$repo" | jq -r '.folders | join(" ")')
        # Version pinned by the canvas. Empty = clone the tip of the branch,
        # which is the long-standing behaviour and what the first stage in the
        # chain does.
        COMMIT=$(echo "$repo" | jq -r '.commit // empty')
        PROVIDER=$(echo "$repo" | jq -r '.provider // "github"')
        FULL_TARGET_DIR="./$TARGET_DIR"
        REPO_URL="https://x-access-token:${GH_CLONE_TOKEN}@github.com/${ORG}/${REPO_NAME}.git"

        if [ ! -d "$FULL_TARGET_DIR" ]; then
            echo "⬇️  Starting sparse checkout of $ORG/$REPO_NAME..."
            git clone --depth 1 -b "$BRANCH" --filter=blob:none --no-checkout "$REPO_URL" "$FULL_TARGET_DIR"
            cd "$FULL_TARGET_DIR"
            git sparse-checkout init --cone
            git sparse-checkout set $FOLDERS
            if [ -n "$COMMIT" ]; then
                # The shallow clone brought only the tip of the branch, and the
                # pinned commit can be older. Fetching it by identifier solves
                # that without downloading the whole history -- GitHub serves a
                # single commit.
                echo "📌 Pinned to $COMMIT"
                git fetch --depth 1 --filter=blob:none origin "$COMMIT"
                git checkout --detach "$COMMIT"
            else
                git checkout "$BRANCH"
            fi
            cd - > /dev/null
        else
            echo "🔄 Updating folders in $REPO_NAME..."
            if [ -n "$COMMIT" ]; then
                echo "📌 Pinned to $COMMIT"
                (cd "$FULL_TARGET_DIR" \
                    && git sparse-checkout set $FOLDERS \
                    && git fetch --depth 1 --filter=blob:none origin "$COMMIT" \
                    && git checkout --detach "$COMMIT")
            else
                (cd "$FULL_TARGET_DIR" && git sparse-checkout set $FOLDERS && git pull origin "$BRANCH")
            fi
        fi

        # What actually ended up in the working tree, not what was asked for.
        # True for both paths: with a pinned version this confirms it arrived;
        # without one, this is the snapshot the next stage will receive.
        RESOLVED=$(cd "$FULL_TARGET_DIR" && git rev-parse HEAD 2>/dev/null) || RESOLVED=""
        if [ -n "$RESOLVED" ]; then
            printf '%s\t%s\n' "${PROVIDER}:${ORG}/${REPO_NAME}" "$RESOLVED" >> "$SOURCES_FILE"
        fi

        # Asked for one version and got another: the clone fell back to the tip
        # of the branch, and the stage would apply code that was never approved.
        # Recorded for the check right after the loop.
        if [ -n "$COMMIT" ] && [ "$RESOLVED" != "$COMMIT" ]; then
            printf '%s: requested %s, got %s\n' \
                "${ORG}/${REPO_NAME}" "$COMMIT" "${RESOLVED:-none}" \
                >> "$PIN_FAILED_FILE"
        fi
    done
fi

if [ -s "$PIN_FAILED_FILE" ]; then
    echo "::error::The pinned version could not be checked out. Nothing was applied."
    cat "$PIN_FAILED_FILE"
    echo "Check that the commit still exists in that repository."
    exit 1
fi

# ---------------------------------------------------------
# ANDAMENTO POR STATE
# ---------------------------------------------------------
# Para onde contar em que state o pipeline esta, enquanto ele corre. Vem do
# manifesto, e nao de uma configuracao aqui: quem monta o manifesto ja sabe com
# qual Worker aquele canvas fala, entao dev, test e producao acertam o proprio
# sem nada para manter sincronizado.
#
# Vazio -- manifesto antigo, ou frontend sem Worker configurado -- e o
# comportamento de sempre: nao reporta nada.
PROGRESS_URL=$(jq -r '.progress_url // empty' "$MANIFEST_PATH")

# Conta ao Struct8 que um state comecou ou terminou.
#
# Ate aqui o canvas do cliente sabia duas coisas: que empurrou, e que terminou.
# O meio -- que passa de vinte minutos num apply de EKS -- nao tinha como ser
# contado, entao os recursos do estagio inteiro ficavam com a mesma marca de "em
# execucao" do primeiro ao ultimo segundo. Cada chamada daqui apaga a marca de um
# recurso na tela, ou pinta de vermelho o que quebrou.
#
# O Worker resolve sozinho de qual canvas e de qual no e este run, cruzando
# repositorio e sha com o registro que o navegador gravou no momento do push. Por
# isso nao vai identidade nenhuma daqui -- e nem poderia: o par (repositorio, sha)
# ele tira do TOKEN, nunca do corpo, e e isso que impede um repositorio qualquer
# de escrever progresso no canvas de outra pessoa.
#
# NUNCA derruba o deploy. Sem `progress_url` nao faz nada; sem token tambem nao;
# e a chamada tem timeout curto com o erro engolido. Este script roda sob `set -e`,
# e um relatorio perdido custa uma animacao, nao uma execucao.
report_state_progress() {
    if [ -z "$PROGRESS_URL" ] || [ -z "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ]; then
        return 0
    fi

    local state_path="$1" status="$2" index="$3" total="$4"
    local token="" corpo=""
    local sources_json="" body_with_sources="" code=""

    # Token OIDC deste run, com audiencia PROPRIA do relatorio de andamento --
    # diferente da `https://struct8.com/gitops` que o GateKeeper valida. Separar as
    # duas e o que impede um token pedido para contar progresso de ser
    # reapresentado ao GateKeeper para cunhar um token de repositorio.
    #
    # `audience`, e nao `aud`: o GitHub ignora parametro desconhecido em silencio e
    # emite a audiencia PADRAO -- ver o caso registrado no engine.yml.
    #
    # Pedido a cada relatorio, e nao uma vez no inicio: o token do Actions vale
    # minutos e um apply de EKS passa de vinte. Quem responde e o servico local do
    # runner, entao a chamada e barata perto de qualquer terraform.
    token=$(curl -sS -m 5 \
        -H "Authorization: bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN}" \
        "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=https://struct8.com/run-progress" \
        2>/dev/null | jq -r '.value // empty' 2>/dev/null) || return 0

    if [ -z "$token" ]; then
        return 0
    fi

    # The code version this run cloned, carried by the first report that gets
    # through. The clone loop wrote one line per source, as
    # `provider:owner/repo<TAB>identifier`; this folds them into the single
    # object the Worker reads.
    if [ -s "${SOURCES_FILE:-}" ]; then
        sources_json=$(jq -Rn \
            '[inputs | split("\t") | select(length == 2) | {(.[0]): .[1]}] | add' \
            < "$SOURCES_FILE" 2>/dev/null) || sources_json=""
    fi

    # Corpo enxuto de proposito: repositorio, sha e link do run saem do token, do
    # lado do Worker. Mandar de novo aqui nao adiantaria nada -- ele ignora o que
    # vier no corpo para esses tres.
    corpo=$(jq -n \
        --arg state "$state_path" \
        --arg status "$status" \
        --argjson index "$index" \
        --argjson total "$total" \
        '{
            state:  $state,
            status: $status,
            index:  $index,
            total:  $total
        }' 2>/dev/null) || return 0

    # Folded into the body already built, rather than built again with the field
    # added: two places building the same object drift apart over time. A failure
    # here keeps the original body, so progress is still reported.
    if [ -n "$sources_json" ] && [ "$sources_json" != "null" ]; then
        body_with_sources=$(printf '%s' "$corpo" \
            | jq -c --argjson sources "$sources_json" '. + { sources: $sources }' \
            2>/dev/null) || body_with_sources=""
        if [ -n "$body_with_sources" ]; then
            corpo="$body_with_sources"
        fi
    fi

    # The status code is read so the run can tell whether the version arrived.
    # Progress itself stays best-effort: a failure here never brings the pipeline
    # down.
    code=$(curl -sS -m 5 -o /dev/null -w '%{http_code}' \
        -X POST \
        -H "Authorization: Bearer ${token}" \
        -H 'Content-Type: application/json' \
        -d "$corpo" \
        "$PROGRESS_URL" 2>/dev/null) || code=""

    # Dropped only after the Worker accepted it, so a report that never arrived
    # is sent again on the next state. Without this the next stage has no version
    # to promote.
    if [ -n "$sources_json" ] && [ "$code" = "200" ]; then
        rm -f "$SOURCES_FILE"
    fi

    return 0
}

if [ -n "$PROGRESS_URL" ]; then
    echo "📡 Reporting per-state progress to the canvas."
fi

# Which state each background job belongs to.
#
# `wait` gives back an exit code and nothing else -- it does not say which
# directory the job was working in. These three lists are what turns that exit
# code back into a state, and they are the reason the parallel branch can report
# progress at all. Index k of the three describes one job.
PAR_PIDS=()
PAR_PATHS=()
PAR_IDX=()

# Waits for every job launched so far and reports each one by name.
#
# Called twice: when the batch fills up to `max_parallel`, and once more after
# the loop for whatever is left. A batch waits for its slowest member, which is
# the price of not depending on `wait -n -p` -- that flag would give a sliding
# window, and it only exists in bash 5.1+.
#
# Sets `failed` (a global of the stage loop) instead of returning it: the caller
# already reads that variable to decide whether the stage as a whole is over.
_drain_parallel_batch() {
    local k
    for k in "${!PAR_PIDS[@]}"; do
        # Condition context on purpose: with `set -e` a bare `wait` on a job that
        # exited non-zero would end the script here, and the state that failed
        # would never be reported -- the node would keep a running badge on a run
        # that is already over.
        if wait "${PAR_PIDS[$k]}"; then
            report_state_progress "${PAR_PATHS[$k]}" "ok" "${PAR_IDX[$k]}" "$STATE_TOTAL"
        else
            report_state_progress "${PAR_PATHS[$k]}" "failed" "${PAR_IDX[$k]}" "$STATE_TOTAL"
            failed=1
        fi
    done
    PAR_PIDS=()
    PAR_PATHS=()
    PAR_IDX=()
}

# ==============================================================================
# ESCALONAMENTO POR DEPENDENCIA
# ==============================================================================
# O laco de estagios abaixo e uma sequencia de barreiras: uma entrada de
# `pipeline_stages` so comeca quando a anterior terminou INTEIRA. Com as entradas
# saindo uma por onda topologica, isso faz um state esperar por gente da rodada
# anterior com quem ele nao tem relacao nenhuma -- dois ramos independentes
# andam no passo do mais lento dos dois.
#
# Aqui os states das entradas viram um conjunto so, e cada um parte assim que os
# do `depends_on` DELE terminaram. Mesmas ligacoes, mesma ordem respeitada,
# menos espera.
#
# Vale quando o manifesto pede (`pipeline_schedule.mode == "dependency"`). Sem o
# campo, nada muda: o manifesto continua trazendo as ondas e o laco de sempre as
# executa. E o que mantem um engine antigo correto diante de um manifesto novo.
#
# POR QUE O CODIGO DE SAIDA VEM DE ARQUIVO, E NAO DE `wait`
#
# `wait` sem -n bloqueia ate UM pid especifico terminar, que e justamente o que
# nao se pode fazer aqui: o proximo a liberar vaga e desconhecido. `wait -n -p`
# resolveria, mas so existe no bash 5.1+, e este script nao escolhe o runner.
# Cada job gravando o proprio codigo de saida num arquivo funciona em qualquer
# bash, e nao depende de quando o shell recolhe o filho.
SCH_PATH=()
SCH_PROVIDER=()
SCH_TARGET_AUTH=()
SCH_ADD_AUTH=()
SCH_DEPS=()
SCH_STATUS=()
SCH_PID=()
SCH_DONE_DIR=""
SCH_RODANDO=0

# 0 quando todo o `depends_on` do state $1 ja terminou com sucesso.
#
# Dependencia que nao esta no conjunto e ignorada: o state nao foi enviado neste
# push, nunca vai reportar, e esperar por ele penduraria o run ate o timeout do
# Actions. Quem monta o manifesto ja descarta essas, e isto e a segunda linha.
_deps_satisfeitas() {
    local idx="$1" dep k achado
    while IFS= read -r dep; do
        [ -z "$dep" ] && continue
        achado=""
        for k in "${!SCH_PATH[@]}"; do
            if [ "${SCH_PATH[$k]}" == "$dep" ]; then
                achado="$k"
                break
            fi
        done
        [ -z "$achado" ] && continue
        [ "${SCH_STATUS[$achado]}" == "ok" ] || return 1
    done <<< "${SCH_DEPS[$idx]}"
    return 0
}

# Recolhe quem terminou desde a ultima passada e reporta cada um pelo nome.
# Devolve 0 se recolheu alguem -- e o sinal de que vale tentar lancar mais sem
# dormir de novo.
_recolher_terminados() {
    local k arquivo codigo recolheu=1
    for k in "${!SCH_STATUS[@]}"; do
        [ "${SCH_STATUS[$k]}" == "running" ] || continue
        arquivo="$SCH_DONE_DIR/$k"
        [ -f "$arquivo" ] || continue

        codigo=$(cat "$arquivo" 2>/dev/null || echo 1)
        case "$codigo" in ''|*[!0-9]*) codigo=1 ;; esac
        wait "${SCH_PID[$k]}" 2>/dev/null || true
        SCH_RODANDO=$((SCH_RODANDO - 1))

        if [ "$codigo" -eq 0 ]; then
            SCH_STATUS[$k]="ok"
            report_state_progress "${SCH_PATH[$k]}" "ok" "$((k + 1))" "${#SCH_PATH[@]}"
            echo "✅ State finished: ${SCH_PATH[$k]}"
        else
            SCH_STATUS[$k]="failed"
            report_state_progress "${SCH_PATH[$k]}" "failed" "$((k + 1))" "${#SCH_PATH[@]}"
            echo "::error::State ${SCH_PATH[$k]} failed"
            failed=1
        fi
        recolheu=0
    done
    return $recolheu
}

run_dependency_schedule() {
    local state path k lancados pendentes max_parallel

    max_parallel=$(jq -r '.pipeline_schedule.max_parallel // empty' "$MANIFEST_PATH")
    case "$max_parallel" in ''|*[!0-9]*) max_parallel=0 ;; esac

    # Todos os states de todas as entradas, na ordem em que aparecem. As entradas
    # continuam sendo as ondas; aqui a divisao delas nao interessa -- quem ordena
    # e o `depends_on`.
    #
    # Tudo o que o lancamento precisa sai do JSON AQUI, uma vez por state. Deixar
    # para extrair na hora de lancar poria tres `jq` dentro do laco de decisao,
    # que roda a cada volta e para cada candidato.
    while read -r state; do
        [ -z "$state" ] && continue
        SCH_PATH+=("$(echo "$state" | jq -r '.path')")
        SCH_PROVIDER+=("$(echo "$state" | jq -r '.provider')")
        SCH_TARGET_AUTH+=("$(echo "$state" | jq -c '.target_auth')")
        SCH_ADD_AUTH+=("$(echo "$state" | jq -c '.additional_auth // []')")
        SCH_DEPS+=("$(echo "$state" | jq -r '(.depends_on // [])[]')")
        SCH_STATUS+=("pending")
        SCH_PID+=("")
    done <<< "$(jq -c '.pipeline_stages[].states[]' "$MANIFEST_PATH")"

    if [ "${#SCH_PATH[@]}" -eq 0 ]; then
        echo "⚠️  Nenhum state no manifesto. Nada a fazer."
        return 0
    fi

    SCH_DONE_DIR=$(mktemp -d)
    failed=0

    echo ""
    echo "=========================================================="
    echo "🚀 ${#SCH_PATH[@]} states, escalonados por dependência (até $max_parallel por vez)"
    echo "=========================================================="

    while true; do
        lancados=0

        # Nada novo comeca depois de uma falha. O que ja esta rodando termina --
        # `terraform apply` nao e interrompivel com seguranca -- e o run acaba.
        if [ $failed -eq 0 ]; then
            for k in "${!SCH_STATUS[@]}"; do
                [ "${SCH_STATUS[$k]}" == "pending" ] || continue
                if [ "$max_parallel" -gt 0 ] && [ "$SCH_RODANDO" -ge "$max_parallel" ]; then
                    break
                fi
                _deps_satisfeitas "$k" || continue

                path="${SCH_PATH[$k]}"

                if [ ! -d "$path" ]; then
                    echo "⚠️  Directory $path does not exist. Skipping."
                    # Conta como concluido, e nao como pendente: quem depende dele
                    # nunca sairia do lugar, e o run morreria no guarda de ciclo
                    # apontando um ciclo que nao existe.
                    SCH_STATUS[$k]="ok"
                    continue
                fi
                if [ -d ".external_modules" ]; then
                    ln -sfn "$(readlink -f .external_modules)" "$path/.external_modules"
                fi

                report_state_progress "$path" "running" "$((k + 1))" "${#SCH_PATH[@]}"
                echo "▶️  State starting: $path"
                (
                    # `set +e` aqui dentro: com o `set -e` da linha 27 o subshell
                    # morreria no terraform que falhou, sem gravar o arquivo, e o
                    # laco ficaria esperando um state que ja acabou.
                    set +e
                    run_terraform_process "$path" "$ACTION" \
                        "${SCH_TARGET_AUTH[$k]}" "${SCH_PROVIDER[$k]}" "${SCH_ADD_AUTH[$k]}"
                    echo "$?" > "$SCH_DONE_DIR/$k"
                ) &
                SCH_PID[$k]=$!
                SCH_STATUS[$k]="running"
                SCH_RODANDO=$((SCH_RODANDO + 1))
                lancados=$((lancados + 1))
            done
        fi

        if [ "$SCH_RODANDO" -eq 0 ] && [ "$lancados" -eq 0 ]; then
            break
        fi

        # Uma passada de recolhimento libera vaga sem dormir. Sem ninguem para
        # recolher, um segundo de espera nao pesa perto de um terraform.
        if ! _recolher_terminados; then
            sleep 1
        fi
    done

    rm -rf "$SCH_DONE_DIR"

    pendentes=0
    for k in "${!SCH_STATUS[@]}"; do
        [ "${SCH_STATUS[$k]}" == "pending" ] && pendentes=$((pendentes + 1))
    done

    if [ $failed -ne 0 ]; then
        echo "::error::Pipeline failed"
        exit 1
    fi

    if [ "$pendentes" -gt 0 ]; then
        # Sem falha, sem ninguem rodando, e ainda sobrou gente esperando: o
        # `depends_on` tem um ciclo. O canvas recusa ciclo antes de gerar o
        # manifesto, entao chegar aqui e manifesto vindo de outra origem -- e o
        # unico jeito honesto de terminar e recusando.
        echo "::error::$pendentes state(s) never became runnable -- depends_on has a cycle"
        exit 1
    fi

    echo "✅ Pipeline finished: ${#SCH_PATH[@]} states"
}

# ---------------------------------------------------------
# EXECUÇÃO DOS ESTÁGIOS
# ---------------------------------------------------------
# Qual dos dois percursos. Ausente = por rodada, que e o que o manifesto de
# qualquer versao anterior pede, e o que este script sempre fez.
SCHEDULE_MODE=$(jq -r '.pipeline_schedule.mode // "stages"' "$MANIFEST_PATH")

if [ "$SCHEDULE_MODE" == "dependency" ]; then
    run_dependency_schedule
    exit 0
fi

TOTAL_STAGES=$(jq '.pipeline_stages | length' "$MANIFEST_PATH")

for (( i=0; i<$TOTAL_STAGES; i++ )); do
    STAGE_NAME=$(jq -r ".pipeline_stages[$i].stage_name" "$MANIFEST_PATH")
    IS_PARALLEL=$(jq -r ".pipeline_stages[$i].parallel_execution" "$MANIFEST_PATH")
    STATES_JSON=$(jq -c ".pipeline_stages[$i].states[]" "$MANIFEST_PATH")
    # Posicao do state dentro do estagio, para o canvas poder dizer "3 de 7".
    # O laco abaixo usa here-string (`<<<`), e nao pipe: ele roda neste mesmo
    # shell, entao o contador sobrevive a cada volta.
    STATE_TOTAL=$(jq ".pipeline_stages[$i].states | length" "$MANIFEST_PATH")
    STATE_INDEX=0
    # How many states of this entry may run at once. Absent or junk means no
    # ceiling, which is what an older manifest asks for: run the whole entry.
    MAX_PARALLEL=$(jq -r ".pipeline_stages[$i].max_parallel // empty" "$MANIFEST_PATH")
    case "$MAX_PARALLEL" in ''|*[!0-9]*) MAX_PARALLEL=0 ;; esac
    PAR_PIDS=()
    PAR_PATHS=()
    PAR_IDX=()

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

    failed=0

    while read -r state; do
        path=$(echo "$state" | jq -r '.path')
        STATE_INDEX=$((STATE_INDEX + 1))
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
            # Reported before launching, and the launch is recorded so the exit
            # code can be traced back to this directory. Without that pairing the
            # canvas had to go dark for the whole parallel run: attributing an
            # outcome to the wrong state would clear the badge of a resource that
            # is still being created.
            report_state_progress "$path" "running" "$STATE_INDEX" "$STATE_TOTAL"
            run_terraform_process "$path" "$ACTION" "$target_auth" "$provider" "$additional_auth" &
            PAR_PIDS+=("$!")
            PAR_PATHS+=("$path")
            PAR_IDX+=("$STATE_INDEX")

            if [ "$MAX_PARALLEL" -gt 0 ] && [ "${#PAR_PIDS[@]}" -ge "$MAX_PARALLEL" ]; then
                _drain_parallel_batch
                # Nothing new is started once something has failed. What is
                # already running finishes -- `terraform apply` cannot be
                # interrupted safely -- and the stage ends right after.
                if [ $failed -ne 0 ]; then break; fi
            fi
        else
            report_state_progress "$path" "running" "$STATE_INDEX" "$STATE_TOTAL"
            run_terraform_process "$path" "$ACTION" "$target_auth" "$provider" "$additional_auth"
            if [ $? -ne 0 ]; then
                report_state_progress "$path" "failed" "$STATE_INDEX" "$STATE_TOTAL"
                failed=1
                break
            fi
            report_state_progress "$path" "ok" "$STATE_INDEX" "$STATE_TOTAL"
        fi
    done <<< "$STATES_JSON"

    if [ "$IS_PARALLEL" == "true" ]; then
        _drain_parallel_batch
    fi

    if [ $failed -ne 0 ]; then
        echo "::error::Stage $STAGE_NAME failed"
        exit 1
    fi

    echo "✅ Stage finished: $STAGE_NAME"
done
