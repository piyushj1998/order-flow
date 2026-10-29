require('dotenv').config({ path: require('node:path').resolve(__dirname, '../../.env') });
const express = require('express');
const path = require('node:path');

const app = express();
const port = Number(process.env.GATEWAY_PORT || 3000);
const publicDir = path.resolve(__dirname, '../../public');

app.get('/health', (_req, res) => res.json({ service: 'api-gateway-ui', status: 'ok' }));
app.use(express.static(publicDir));
app.get('/{*path}', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

app.listen(port, () => console.log(`[gateway] UI available at http://localhost:${port}`));
