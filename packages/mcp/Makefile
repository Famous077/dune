# How McpFn is built. `sam build` runs this, the same way packages/api/Makefile builds ApiFn:
# SAM copies this package to a temp directory, so the bundle is built from the monorepo root,
# found through this file's real path.
#
# One ESM bundle with every dependency inlined — the MCP SDK and zod — so the artifact is a
# single file. The createRequire banner lets bundled CommonJS dependencies (ajv) call require.

MCP_DIR := $(dir $(abspath $(firstword $(MAKEFILE_LIST))))
ROOT := $(abspath $(MCP_DIR)../..)

build-McpFn:
	cd $(ROOT) && ./node_modules/.bin/esbuild packages/mcp/src/lambda.ts \
		--bundle \
		--platform=node \
		--target=node24 \
		--format=esm \
		--sourcemap \
		--banner:js="import { createRequire as __duneCreateRequire } from 'node:module'; const require = __duneCreateRequire(import.meta.url);" \
		--log-level=warning \
		--outfile="$(ARTIFACTS_DIR)/lambda.mjs"
