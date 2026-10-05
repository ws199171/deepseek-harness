/**
 * Execution viewer plugin, node half. The capability is a browser View over
 * Conversation events, so the Host half carries no behavior; the empty `apply`
 * exists so the plugin appears in the host cordis.yml / Loader, and the browser
 * half ships through `exports["./client"]`, discovered from the package's
 * `dsh.client` declaration.
 */

/** Host plugin body — no host-side behavior for this browser View plugin. */
export function apply(): void {}
