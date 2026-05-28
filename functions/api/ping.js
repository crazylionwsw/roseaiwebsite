// Diagnostic endpoint — confirms Cloudflare Pages Functions are deployed
// Test: GET https://www.roseai.ca/api/ping
export async function onRequest() {
    return new Response(JSON.stringify({
        status: 'ok',
        functions: 'deployed',
        contactEndpoint: '/api/contact',
        time: new Date().toISOString()
    }), {
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        }
    });
}
