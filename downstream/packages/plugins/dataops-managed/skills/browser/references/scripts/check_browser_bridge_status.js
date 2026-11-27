process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

async function main() {
  const backendOrigin = process.env.DATAOPS_BROWSER_BRIDGE_BACKEND_ORIGIN || 'https://127.0.0.1:3101';
  const account = process.env.DATAOPS_BROWSER_BRIDGE_ACCOUNT || 'admin';
  const password = process.env.DATAOPS_BROWSER_BRIDGE_PASSWORD;
  if (!password) {
    throw new Error('set DATAOPS_BROWSER_BRIDGE_PASSWORD before running this script');
  }
  const loginResponse = await fetch(`${backendOrigin}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account, password }),
  });
  if (!loginResponse.ok) {
    throw new Error(`Login failed: ${loginResponse.status}`);
  }
  const loginPayload = await loginResponse.json();
  const toolsResponse = await fetch(`${backendOrigin}/api/ai/tools`, {
    headers: { Authorization: `Bearer ${loginPayload.accessToken}` },
  });
  if (!toolsResponse.ok) {
    throw new Error(`GET /api/ai/tools failed: ${toolsResponse.status}`);
  }
  const toolsPayload = await toolsResponse.json();
  const browserTool = toolsPayload.tools.find((tool) => tool.name === 'browser');
  console.log(JSON.stringify(browserTool ?? null, null, 2));
}

main().catch((error) => {
  console.error(String(error));
  process.exit(1);
});
