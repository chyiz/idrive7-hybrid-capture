'use strict';
/**
 * recorder.js - Disk-safe JSONL capture recorder for Hybrid Capture.
 *
 * Writes newline-delimited JSON records to `<dataDir>/captures/capture-<ts>.jsonl`
 * and mirrors every appended line to `/tmp/hybrid-capture-latest.jsonl` (mode 0644)
 * so SSH pulls work with a single fixed path without hunting for `oap_<uid>`.
 *
 * Strict Node 8.16.2 (ES2017): no optional chaining, no ??, no recursive mkdirSync.
 */

const fs = require('fs');
const path = require('path');

const MAX_FILE_BYTES = 2 * 1024 * 1024;   // 2 MiB cap per capture session
const MAX_SESSIONS = 10;                  // Keep at most 10 files (<= 20 MiB OAP quota)
const DEFAULT_MIRROR = '/tmp/hybrid-capture-latest.jsonl';

function pad2(n) {
    return n < 10 ? '0' + n : String(n);
}

function formatStamp(ms) {
    const d = new Date(ms);
    return (
        d.getUTCFullYear() +
        pad2(d.getUTCMonth() + 1) +
        pad2(d.getUTCDate()) + '-' +
        pad2(d.getUTCHours()) +
        pad2(d.getUTCMinutes()) +
        pad2(d.getUTCSeconds())
    );
}

function ensureDir(dirPath) {
    if (!dirPath) return false;
    try {
        if (fs.existsSync(dirPath)) return true;
        fs.mkdirSync(dirPath, 0o755);
        return true;
    } catch (e) {
        return fs.existsSync(dirPath);
    }
}

class CaptureRecorder {
    constructor(opts) {
        const o = opts || {};
        this.dataDir = o.dataDir || process.cwd();
        this.capturesDir = path.join(this.dataDir, 'captures');
        this.mirrorPath = o.mirrorPath !== undefined ? o.mirrorPath : DEFAULT_MIRROR;
        this.maxFileBytes = o.maxFileBytes || MAX_FILE_BYTES;
        this.maxSessions = o.maxSessions || MAX_SESSIONS;
        this.log = o.log || { info: () => {}, warn: () => {}, error: () => {} };
        this.appVersion = o.appVersion || '0.1.0';

        this.active = false;
        this.sessionFile = null;
        this.sessionName = null;
        this.startedAt = 0;
        this.events = 0;
        this.bytes = 0;
        this.markers = 0;
        this.iceTransitions = 0;
        this.phase = 'untagged';
        this.mirrorOk = false;
        this.lastError = null;
        this._capped = false;
    }

    start(initialMeta, nowMs) {
        const now = typeof nowMs === 'number' ? nowMs : Date.now();
        if (this.active) return this.status(now);

        if (!ensureDir(this.capturesDir)) {
            this.lastError = 'cannot create captures dir';
            this.log.warn('recorder: ' + this.lastError);
            return this.status(now);
        }

        this._pruneOldSessions();

        const stamp = formatStamp(now);
        this.sessionName = 'capture-' + stamp + '.jsonl';
        this.sessionFile = path.join(this.capturesDir, this.sessionName);
        this.startedAt = now;
        this.events = 0;
        this.bytes = 0;
        this.markers = 0;
        this.iceTransitions = 0;
        this._capped = false;
        this.lastError = null;
        this.active = true;

        if (this.mirrorPath) {
            try {
                fs.writeFileSync(this.mirrorPath, '');
                fs.chmodSync(this.mirrorPath, 0o644);
                this.mirrorOk = true;
            } catch (e) {
                this.mirrorOk = false;
            }
        }

        this._write({
            type: 'session_start',
            version: this.appVersion,
            file: this.sessionName,
            phase: this.phase,
            meta: initialMeta || {},
        }, now);

        this.log.info('capture started: ' + this.sessionFile);
        return this.status(now);
    }

    stop(reason, finalSnapshot, nowMs) {
        const now = typeof nowMs === 'number' ? nowMs : Date.now();
        if (!this.active) return this.status(now);

        this._write({
            type: 'session_stop',
            reason: reason || 'manual',
            durationSec: Math.round((now - this.startedAt) / 1000),
            events: this.events,
            markers: this.markers,
            iceTransitions: this.iceTransitions,
            snapshot: finalSnapshot || null,
        }, now);

        this.active = false;
        this.log.info('capture stopped (' + (reason || 'manual') + '): ' + this.sessionName + ' (' + this.events + ' events, ' + this.bytes + ' B)');
        return this.status(now);
    }

    setPhase(phase, snapshot, nowMs) {
        const now = typeof nowMs === 'number' ? nowMs : Date.now();
        this.phase = String(phase || 'untagged');
        if (this.active) {
            this._write({
                type: 'phase',
                phase: this.phase,
                snapshot: snapshot || null,
            }, now);
        }
        return this.phase;
    }

    recordSignal(iface, field, raw, decoded, nowMs) {
        if (!this.active) return false;
        return this._write({
            type: 'sig',
            phase: this.phase,
            iface: iface,
            field: field,
            raw: raw,
            val: decoded,
        }, nowMs);
    }

    recordTick(snapshot, nowMs) {
        if (!this.active) return false;
        return this._write({
            type: 'tick',
            phase: this.phase,
            s: snapshot,
        }, nowMs);
    }

    recordIceTransition(direction, snapshot, nowMs) {
        if (!this.active) return false;
        this.iceTransitions += 1;
        return this._write({
            type: 'ice_transition',
            phase: this.phase,
            direction: direction,
            s: snapshot,
        }, nowMs);
    }

    recordMarker(label, snapshot, nowMs) {
        if (!this.active) return false;
        this.markers += 1;
        return this._write({
            type: 'marker',
            phase: this.phase,
            label: label || 'mark',
            s: snapshot,
        }, nowMs);
    }

    recordProbe(action, payload, result, snapshot, nowMs) {
        if (!this.active) return false;
        return this._write({
            type: 'probe',
            phase: this.phase,
            action: action,
            payload: payload,
            result: result,
            s: snapshot,
        }, nowMs);
    }

    _write(record, nowMs) {
        if (!this.active || !this.sessionFile || this._capped) return false;
        const now = typeof nowMs === 'number' ? nowMs : Date.now();
        const obj = Object.assign({
            t: now,
            iso: new Date(now).toISOString(),
            dt: Math.max(0, now - this.startedAt),
        }, record);
        let line;
        try {
            line = JSON.stringify(obj) + '\n';
        } catch (e) {
            this.lastError = 'json stringify error';
            return false;
        }
        const len = Buffer.byteLength(line, 'utf8');
        if (this.bytes + len > this.maxFileBytes) {
            this._capped = true;
            this.lastError = 'session size cap reached (' + Math.round(this.maxFileBytes / 1024) + ' KB)';
            this.log.warn('recorder: ' + this.lastError);
            try {
                const capLine = JSON.stringify({
                    t: now,
                    iso: new Date(now).toISOString(),
                    dt: Math.max(0, now - this.startedAt),
                    type: 'size_cap',
                    maxBytes: this.maxFileBytes,
                }) + '\n';
                fs.appendFileSync(this.sessionFile, capLine);
                if (this.mirrorOk && this.mirrorPath) fs.appendFileSync(this.mirrorPath, capLine);
            } catch (e2) { /* ignore */ }
            return false;
        }

        try {
            fs.appendFileSync(this.sessionFile, line);
            this.bytes += len;
            this.events += 1;
        } catch (e) {
            this.lastError = String(e && e.message || e);
            this.log.warn('recorder write failed: ' + this.lastError);
            return false;
        }

        if (this.mirrorOk && this.mirrorPath) {
            try {
                fs.appendFileSync(this.mirrorPath, line);
            } catch (e) {
                this.mirrorOk = false;
            }
        }
        return true;
    }

    listSessions() {
        try {
            if (!fs.existsSync(this.capturesDir)) return [];
            const files = fs.readdirSync(this.capturesDir)
                .filter((f) => /^capture-.*\.jsonl$/.test(f))
                .sort()
                .reverse();
            return files.map((name) => {
                const full = path.join(this.capturesDir, name);
                let size = 0;
                try { size = fs.statSync(full).size; } catch (e) { size = 0; }
                return { name: name, path: full, size: size };
            });
        } catch (e) {
            return [];
        }
    }

    _pruneOldSessions() {
        const list = this.listSessions();
        while (list.length >= this.maxSessions) {
            const oldest = list.pop();
            try { fs.unlinkSync(oldest.path); } catch (e) { /* ignore */ }
        }
    }

    clearAll() {
        const wasActive = this.active;
        if (wasActive) this.stop('clear_all', null);
        const list = this.listSessions();
        let removed = 0;
        for (let i = 0; i < list.length; i++) {
            try {
                fs.unlinkSync(list[i].path);
                removed += 1;
            } catch (e) { /* ignore */ }
        }
        if (this.mirrorPath) {
            try { if (fs.existsSync(this.mirrorPath)) fs.unlinkSync(this.mirrorPath); } catch (e) { /* ignore */ }
        }
        return removed;
    }

    status(nowMs) {
        const now = typeof nowMs === 'number' ? nowMs : Date.now();
        return {
            active: this.active,
            phase: this.phase,
            sessionName: this.sessionName,
            sessionFile: this.sessionFile,
            mirrorPath: this.mirrorPath,
            mirrorOk: this.mirrorOk,
            durationSec: this.active ? Math.max(0, Math.floor((now - this.startedAt) / 1000)) : 0,
            events: this.events,
            bytes: this.bytes,
            markers: this.markers,
            iceTransitions: this.iceTransitions,
            capped: this._capped,
            lastError: this.lastError,
        };
    }
}

module.exports = { CaptureRecorder, MAX_FILE_BYTES, MAX_SESSIONS, DEFAULT_MIRROR };
