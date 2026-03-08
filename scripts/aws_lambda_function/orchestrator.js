const handleCreate = require('./create');
const handlePush = require('./push');
const handlePull = require('./pull');

const direction = process.env.INPUT_DIRECTION;
const defaultRegion = process.env.INPUT_REGION;
let resources = [];

try {
    resources = JSON.parse(process.env.INPUT_RESOURCES);
} catch (e) {
    console.error("❌ Failed to parse resources_json.");
    process.exit(1);
}

console.log(`🚀 Starting ${direction.toUpperCase()} for ${resources.length} resources...`);

for (const res of resources) {
    // Padronizando o objeto de recurso para facilitar para os módulos
    const resourceData = {
        funcId: res.function_arn || res.id,
        folder: res.folder_path || res.git_path,
        region: res.region || defaultRegion,
        runtime: (res.runtime || '').trim()
    };

    console.log(`\n---------------------------------------------------`);
    console.log(`📦 Resource: ${resourceData.funcId}`);
    console.log(`📂 Folder: ${resourceData.folder}`);
    console.log(`⚙️ Runtime: ${resourceData.runtime || 'Unknown'}`);

    try {
        switch (direction) {
            case 'create':
                handleCreate(resourceData);
                break;
            case 'push':
                handlePush(resourceData);
                break;
            case 'pull':
                handlePull(resourceData);
                break;
            default:
                throw new Error(`Unknown direction: ${direction}`);
        }
    } catch (error) {
        console.error(`❌ Failed to process ${resourceData.funcId}:`, error.message);
        process.exit(1); // Para o workflow se houver erro
    }
}
