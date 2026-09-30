// A nested Node test process must start a runner, not inherit its parent's worker protocol.
export function subprocessTestEnv(overrides = {}) {
	const env = { ...process.env, ...overrides };
	delete env.NODE_TEST_CONTEXT;
	return env;
}
