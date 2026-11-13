// Who may talk to the dashboard. The server listens on 127.0.0.1 only, but a
// website can point its own name at 127.0.0.1 (DNS rebinding) and then send
// requests that the browser calls same-origin. So the server answers only a Host
// of 127.0.0.1:<port> or localhost:<port> (server.mjs refuses any other first),
// and an Origin is compared with that FIXED set, never with the request's own
// Host header, which the caller controls.

export const localHosts = port => [`127.0.0.1:${port}`, `localhost:${port}`]

export const hostAllowed = (host, port) => localHosts(port).includes(String(host ?? '').toLowerCase())

export const originAllowed = (origin, port) => localHosts(port).some(h => origin === `http://${h}`)
