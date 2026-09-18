# How ApiFn is built. `sam build` runs this; there is no separate build step.
#
# SAM copies this package into a temp directory and runs `make build-ApiFn` there, so the
# bundle cannot be built from the working directory — the monorepo root is not in it, and
# the npm workspace package @dune/shared would not resolve. SAM does pass this file by
# its real path, which is how the root is found below.
#
# esbuild inlines the workspace package and the AWS SDK, so the deployed artifact is one
# file with nothing to npm install and no runtime SDK version to be surprised by.

API_DIR := $(dir $(abspath $(firstword $(MAKEFILE_LIST))))
ROOT := $(abspath $(API_DIR)../..)

build-ApiFn:
	cd $(ROOT) && ./node_modules/.bin/esbuild packages/api/src/index.ts \
		--bundle \
		--platform=node \
		--target=node24 \
		--format=cjs \
		--sourcemap \
		--outfile="$(ARTIFACTS_DIR)/index.js"
