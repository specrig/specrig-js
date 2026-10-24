PROTOCOL ?= ../protocol
VENDORED := packages/web/protocol

build:
	npm install --no-audit --no-fund
	npm run build

test: build
	npm test

# Without Node or Playwright's browsers, and in CI.
DOCKER := docker run --rm --ipc=host -v $(CURDIR):/specrig-js -v specrig-js-node-modules:/specrig-js/node_modules \
	-w /specrig-js mcr.microsoft.com/playwright:v1.63.0-noble

build-docker:
	$(DOCKER) sh -c 'npm install --no-audit --no-fund && npm run build'

test-docker:
	$(DOCKER) sh -c 'npm install --no-audit --no-fund && npm run build && npm test'

protocol:
	rm -rf $(VENDORED)
	mkdir -p $(VENDORED)/agents $(VENDORED)/fixtures/records $(VENDORED)/fixtures/agents $(VENDORED)/fixtures/markers
	cp $(PROTOCOL)/modes.yaml $(VENDORED)/
	cp $(PROTOCOL)/agents/*.md $(VENDORED)/agents/
	cp $(PROTOCOL)/fixtures/records/* $(VENDORED)/fixtures/records/
	cp $(PROTOCOL)/fixtures/agents/* $(VENDORED)/fixtures/agents/
	cp $(PROTOCOL)/fixtures/markers/* $(VENDORED)/fixtures/markers/

.PHONY: build test build-docker test-docker protocol
