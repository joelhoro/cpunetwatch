/* devstub.js -- development hot-reload shim.
 *
 * GNOME's loader does `await import(extensionJs.get_uri())` with no cache
 * busting, and comments that "extensions can only be imported once". So the
 * shell cannot pick up edited code without restarting -- which on Wayland
 * means logging out.
 *
 * This stub is the one file the shell ever imports. The real extension lives
 * in impl-<n>/, and each reload writes a new n. A different directory is a
 * different URI, so the dynamic import below genuinely loads fresh code, and
 * disable+enable is enough to swap it in.
 *
 * Shipped releases do not include this; `make dev-install` installs it.
 */

import GLib from 'gi://GLib';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const HERE = GLib.path_get_dirname(import.meta.url.replace(/^file:\/\//, ''));

function currentImpl() {
    try {
        const [ok, bytes] = GLib.file_get_contents(
            GLib.build_filenamev([HERE, 'impl.txt']));
        if (ok) {
            const n = parseInt(new TextDecoder().decode(bytes).trim(), 10);
            if (Number.isFinite(n))
                return n;
        }
    } catch { /* fall through */ }
    return 1;
}

export default class DevStub extends Extension {
    enable() {
        const n = currentImpl();
        this._generation = n;
        this._inner = null;
        this._disabled = false;

        import(`file://${HERE}/impl-${n}/extension.js`)
            .then(mod => {
                // disable() may have run while the import was in flight
                if (this._disabled || n !== this._generation)
                    return;
                this._inner = new mod.default(this.metadata);
                this._inner.enable();
            })
            .catch(e => {
                logError(e, `cpunetwatch devstub: impl-${n} failed to load`);
            });
    }

    disable() {
        this._disabled = true;
        try {
            this._inner?.disable();
        } catch (e) {
            logError(e, 'cpunetwatch devstub: inner disable failed');
        }
        this._inner = null;
    }
}
