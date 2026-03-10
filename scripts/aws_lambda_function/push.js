const { run } = require('./utils');
const { execSync } = require('child_process');

function handlePush(resource) {
    const { funcId, folder, region } = resource;
    console.log('🔽 Downloading code from AWS...');
    
    const getUrlCmd = `aws lambda get-function --function-name "${funcId}" --query 'Code.Location' --output text --region ${region}`;
    
    let url;
    try {
        // O { stdio: 'pipe' } impede que o erro vaze solto no console e permite tratar ele
        url = execSync(getUrlCmd, { stdio: 'pipe' }).toString().trim();
    } catch (error) {
        // Extrai a mensagem de erro do AWS CLI
        const errorMessage = error.stderr ? error.stderr.toString().trim() : error.message;
        throw new Error(errorMessage); // Isso será pego pelo catch no orchestrator.js
    }

    if (!url || url === 'None') {
        throw new Error(`Could not get code URL for ${funcId}. Check if function exists.`);
    }

    run(`mkdir -p temp_lambda_dl`);
    run(`curl -sL "${url}" -o lambda_dl.zip`);
    run(`unzip -o -q lambda_dl.zip -d temp_lambda_dl`);
    run(`mkdir -p "${folder}"`);
    run(`rsync -av --delete --exclude '.git' temp_lambda_dl/ "${folder}/"`);
    run(`rm -rf temp_lambda_dl lambda_dl.zip`);
}

module.exports = handlePush;
