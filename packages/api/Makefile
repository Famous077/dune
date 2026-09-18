# How ApiFn and IndexFn are built. `sam build` runs this; there is no separate build step.
#
# Both functions deploy the same artifact and differ only in their handler, so this one
# recipe builds both. IndexFn's CodeUri points here too, even though its code lives in
# packages/indexer: the artifact needs the same model and native runtime either way.
#
# SAM copies this package into a temp directory and runs `make build-<Function>` there, so
# the bundles cannot be built from the working directory — the monorepo root is not in it,
# and the npm workspace packages would not resolve. SAM does pass this file by its real
# path, which is how the root is found below.
#
# The artifact:
#
#   index.mjs                    ApiFn: the HTTP handlers.
#   indexer.mjs                  IndexFn: the indexing pipeline for one job.
#                                Both are single ESM bundles — workspace packages, AWS SDK,
#                                transformers.js inlined. ESM because transformers reads
#                                import.meta.url as it loads, which a CJS bundle breaks.
#   models/Xenova/...            the embedding model, bundled so a cold start never
#                                downloads it. Pinned to the revision in LocalEmbedder.
#   grammars/*.wasm              the TypeScript and TSX tree-sitter grammars, for GRAMMAR_DIR.
#   node_modules/onnxruntime-*   the native ONNX runtime, Linux arm64 binary only. It ships
#                                prebuilt in the npm package, so nothing is compiled.
#   node_modules/web-tree-sitter the parser runtime. Kept out of the bundle because it finds
#                                its own .wasm beside itself.
#
# sharp and onnxruntime-web are replaced with stubs: text embedding uses neither, and
# leaving them out avoids a native image library and several megabytes of WebAssembly.

API_DIR := $(dir $(abspath $(firstword $(MAKEFILE_LIST))))
ROOT := $(abspath $(API_DIR)../..)

MODEL := Xenova/all-MiniLM-L6-v2
# One source of truth: read the pinned revision out of LocalEmbedder.
MODEL_REVISION := $(shell grep -oE "MODEL_REVISION = '[0-9a-f]{40}'" $(ROOT)/packages/indexer/src/embedders/local.ts | grep -oE "[0-9a-f]{40}")
MODEL_FILES := config.json tokenizer.json tokenizer_config.json onnx/model_quantized.onnx

# Downloaded once, at build time, into a gitignored cache keyed by revision.
MODEL_CACHE := $(ROOT)/.models/$(MODEL_REVISION)

ORT_PLATFORM := linux/arm64
GRAMMARS := tree-sitter-typescript.wasm tree-sitter-tsx.wasm

build-ApiFn build-IndexFn:
	@test -n "$(MODEL_REVISION)" || { echo "Could not read MODEL_REVISION from local.ts"; exit 1; }

	# 1. Model files, fetched at build time and never at cold start.
	@for file in $(MODEL_FILES); do \
		target="$(MODEL_CACHE)/$(MODEL)/$$file"; \
		if [ ! -s "$$target" ]; then \
			echo "fetching $(MODEL)@$(MODEL_REVISION) $$file"; \
			mkdir -p "$$(dirname "$$target")" && \
			curl -fsSL -o "$$target.part" "https://huggingface.co/$(MODEL)/resolve/$(MODEL_REVISION)/$$file" && \
			mv "$$target.part" "$$target" || exit 1; \
		fi; \
	done

	# 2. The two bundles.
	cd $(ROOT) && ./node_modules/.bin/esbuild \
		index=packages/api/src/index.ts \
		indexer=packages/indexer/src/lambda.ts \
		--bundle \
		--platform=node \
		--target=node24 \
		--format=esm \
		--sourcemap \
		--external:onnxruntime-node \
		--external:web-tree-sitter \
		--alias:sharp=./packages/api/src/stubs/sharp.ts \
		--alias:onnxruntime-web=./packages/api/src/stubs/onnxruntime-web.ts \
		--banner:js="import { createRequire as __duneCreateRequire } from 'node:module'; const require = __duneCreateRequire(import.meta.url);" \
		--log-level=warning \
		--out-extension:.js=.mjs \
		--outdir="$(ARTIFACTS_DIR)"

	# 3. The model, into the path EMBED_MODEL_DIR points at.
	mkdir -p "$(ARTIFACTS_DIR)/models"
	cp -R "$(MODEL_CACHE)/Xenova" "$(ARTIFACTS_DIR)/models/"

	# 4. The grammars, into the path GRAMMAR_DIR points at.
	mkdir -p "$(ARTIFACTS_DIR)/grammars"
	for grammar in $(GRAMMARS); do cp "$(ROOT)/node_modules/@vscode/tree-sitter-wasm/wasm/$$grammar" "$(ARTIFACTS_DIR)/grammars/"; done

	# 5. The native runtimes: ONNX with every platform but the Lambda's removed, and the
	#    tree-sitter runtime, which is WebAssembly and needs no platform.
	mkdir -p "$(ARTIFACTS_DIR)/node_modules"
	cp -R "$(ROOT)/node_modules/onnxruntime-node" "$(ROOT)/node_modules/onnxruntime-common" "$(ROOT)/node_modules/web-tree-sitter" "$(ARTIFACTS_DIR)/node_modules/"
	rm -rf "$(ARTIFACTS_DIR)/node_modules/web-tree-sitter/debug"
	find "$(ARTIFACTS_DIR)/node_modules/onnxruntime-node/bin/napi-v3" -mindepth 2 -maxdepth 2 -type d \
		! -path "*/$(ORT_PLATFORM)" -exec rm -rf {} +
	test -f "$(ARTIFACTS_DIR)/node_modules/onnxruntime-node/bin/napi-v3/$(ORT_PLATFORM)/onnxruntime_binding.node"
