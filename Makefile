UUID    = cpunetwatch@joelhoro.github.io
SRC     = src
DIST    = dist
BUILD   = build
# Single source of truth for the version: the git tag. Stamped into
# metadata.json at pack time so the published label cannot drift from the
# release, which it silently did across three tags.
VERSION = $(shell git describe --tags --abbrev=0 2>/dev/null | sed 's/^v//')
EXTRA   = sensors.js net.js history.js draw.js graph.js tiger.js claude.js prochot
INSTALL = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: all test pack install uninstall preview clean lint stamp dev-install reload

all: pack

test:
	@for t in selftest nettest histtest drawtest tigertest claudetest; do \
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
stamp:
	@rm -rf $(BUILD) && mkdir -p $(BUILD) $(DIST)
	@cp $(SRC)/extension.js $(SRC)/metadata.json $(SRC)/stylesheet.css $(BUILD)/
	@$(foreach f,$(EXTRA),cp $(SRC)/$(f) $(BUILD)/;)
	@python3 -c "import json,pathlib,sys; \
	  v='$(VERSION)' or '0.0.0'; \
	  p=pathlib.Path('$(BUILD)/metadata.json'); \
	  m=json.loads(p.read_text()); m['version-name']=v; \
	  p.write_text(json.dumps(m,indent=2)+chr(10)); \
	  print('  stamped version-name =',v)"

pack: lint stamp
	@rm -f $(DIST)/$(UUID).shell-extension.zip
	@if command -v gnome-extensions >/dev/null 2>&1; then \
	  gnome-extensions pack $(BUILD) --force -o $(DIST) \
	    $(foreach f,$(EXTRA),--extra-source=$(f)); \
	else \
	  echo "gnome-extensions absent; packing with zip"; \
	  (cd $(BUILD) && zip -q -X ../$(DIST)/$(UUID).shell-extension.zip \
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
	@rm -rf $(DIST) $(BUILD)

# ---------------------------------------------------------------- dev reload
#
# The shell imports extension.js exactly once per session. dev-install puts a
# stub there that dynamically imports impl-<n>/, so `make reload` can bump n
# and swap in edited code with no logout. Keeps the two most recent impls:
# the outgoing module stays resident in the shell after disable.

DEVDIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

dev-install: lint
	@mkdir -p $(DEVDIR)
	@rm -f $(DEVDIR)/*.js
	@cp tools/devstub.js $(DEVDIR)/extension.js
	@cp $(SRC)/metadata.json $(DEVDIR)/metadata.json
	@cp $(SRC)/stylesheet.css $(DEVDIR)/stylesheet.css
	@cp $(SRC)/prochot $(DEVDIR)/prochot && chmod +x $(DEVDIR)/prochot
	@echo 1 > $(DEVDIR)/impl.txt
	@rm -rf $(DEVDIR)/impl-1 && mkdir -p $(DEVDIR)/impl-1
	@cp $(SRC)/*.js $(SRC)/metadata.json $(DEVDIR)/impl-1/
	@echo "dev stub installed. Log out once, then use 'make reload'."

reload: lint
	@test -f $(DEVDIR)/impl.txt || { echo "run 'make dev-install' first"; exit 1; }
	@n=$$(cat $(DEVDIR)/impl.txt); next=$$((n+1)); \
	  rm -rf $(DEVDIR)/impl-$$next && mkdir -p $(DEVDIR)/impl-$$next; \
	  cp $(SRC)/*.js $(SRC)/metadata.json $(DEVDIR)/impl-$$next/; \
	  cp $(SRC)/stylesheet.css $(DEVDIR)/stylesheet.css; \
	  cp $(SRC)/prochot $(DEVDIR)/prochot; chmod +x $(DEVDIR)/prochot; \
	  echo $$next > $(DEVDIR)/impl.txt; \
	  gnome-extensions disable $(UUID); sleep 1; \
	  gnome-extensions enable $(UUID); sleep 1; \
	  old=$$((next-2)); [ -d $(DEVDIR)/impl-$$old ] && rm -rf $(DEVDIR)/impl-$$old || true; \
	  echo "reloaded as impl-$$next"; \
	  gnome-extensions info $(UUID) | grep -E "State|Error" || true
