// The Worker env (bindings, vars, secrets) set once per request, so the lib modules
// can read configuration the same way the local server read process.env.
let current = {};

export const setEnv = (e) => { current = e || {}; };
export const getEnv = () => current;
