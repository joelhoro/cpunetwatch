UUID    = cpunetwatch@joelhoro.github.io
SRC     = src
DIST    = dist
EXTRA   = sensors.js net.js history.js draw.js graph.js
INSTALL = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: all test pack install uninstall preview clean lint

all: pack

test:
	@for t in selftest nettest histtest drawtest; do \
	  printf '%-10s ' $$t; \
	  gjs -m $(SRC)/$$t.js 2>&1 | tail -1; \
	done

preview:
	@gjs -m $(SRC)/graphtest.js

lint:
	@for f in $(SRC)/*.js; do node --check $$f || exit 1; done
	@echo "all JS parses"

pack: lint
	@mkdir -p $(DIST)
	@gnome-extensions pack $(SRC) --force -o $(DIST) \
	  $(foreach f,$(EXTRA),--extra-source=$(f))
	@ls -lh $(DIST)/$(UUID).shell-extension.zip

install: pack
	@gnome-extensions install $(DIST)/$(UUID).shell-extension.zip --force
	@echo "installed - log out and back in, then:"
	@echo "  gnome-extensions enable $(UUID)"

uninstall:
	@gnome-extensions uninstall $(UUID) || rm -rf $(INSTALL)

clean:
	@rm -rf $(DIST)
