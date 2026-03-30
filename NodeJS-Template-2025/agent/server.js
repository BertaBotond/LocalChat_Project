const http = require('http');

const host = process.env.AGENT_HOST || '0.0.0.0';
const port = Number(process.env.AGENT_PORT) || 4123;

const server = http.createServer((request, response) => {
    if (request.url === '/health') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(
            JSON.stringify({
                status: 'ok',
                service: 'lan-agent',
                timestamp: new Date().toISOString()
            })
        );
        return;
    }

    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ message: 'Not found' }));
});

server.listen(port, host, () => {
    console.log(`LAN agent listening on http://${host}:${port}`);
});
