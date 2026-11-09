UUID    = cpunetwatch@joelhoro.github.io
SRC     = src
DIST    = dist
EXTRA   = sensors.js net.js history.js draw.js graph.js tiger.js prochot
INSTALL = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: all test pack install uninstall preview clean lint

all: pack

test:
	@for t in selftest nettest histtest drawtest tigertest; do \
	  printf '%-10s ' $$t; \
	  gjs -m $(SRC)/$$t.js 2>&1 | tail -1; \
	done

preview:
	@gjs -m $(SRC)/graphtest.js

lint:
	@for f in $(SRC)/*.js; do node --check $$f || exit 1; done
	@echo "all JS parses"

# gnome-extensions ships with gnome-shell, which CI runners lack. The bundle
# is just a flat zip of the runtime files, so fall back to zip(1) there.
pack: lint
	@mkdir -p $(DIST)
	@rm -f $(DIST)/$(UUID).shell-extension.zip
	@if command -v gnome-extensions >/dev/null 2>&1; then \
	  gnome-extensions pack $(SRC) --force -o $(DIST) \
	    $(foreach f,$(EXTRA),--extra-source=$(f)); \
	else \
	  echo "gnome-extensions absent; packing with zip"; \
	  (cd $(SRC) && zip -q -X ../$(DIST)/$(UUID).shell-extension.zip \
	     extension.js metadata.json stylesheet.css $(EXTRA)); \
	fi
	@ls -lh $(DIST)/$(UUID).shell-extension.zip

install: pack
	@gnome-extensions install $(DIST)/$(UUID).shell-extension.zip --force
	@echo "installed - log out and back in, then:"
	@echo "  gnome-extensions enable $(UUID)"

uninstall:
	@gnome-extensions uninstall $(UUID) || rm -rf $(INSTALL)

clean:
	@rm -rf $(DIST)
