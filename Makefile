PLAYWRIGHT := mcr.microsoft.com/playwright:v1.63.0-noble
RUN := docker run --rm --ipc=host -v $(CURDIR):/specrig-js -v specrig-js-node-modules:/specrig-js/node_modules -w /specrig-js $(PLAYWRIGHT)

build:
	$(RUN) sh -c 'npm install --no-audit --no-fund && npm run build'

test:
	$(RUN) sh -c 'npm install --no-audit --no-fund && npm run build && npm test'

.PHONY: build test
