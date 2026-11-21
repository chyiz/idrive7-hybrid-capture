'use strict';
/**
 * main.js - Hybrid Capture entry point for BMW iDrive 7 (MGU OAP).
 *
 * Native full-width RHMI menus (`LT_State_Wide`, zero external renderer required):
 *   - MAIN     : Live summary, Start/Stop recording, 1-click ICE Cut-In marker, phase tags
 *   - LIVE     : Full 8-row live VEM / Hybrid / Sailing / Nav / Resync signal monitor
 *   - PROBES   : Safety-gated (disarmed by default) Option 1 & Option 3 SOME/IP write probes
 *   - SESSIONS : Saved JSONL capture inventory, /tmp mirror path, clear & settings
 *
 * Strict Node 8.16.2 (ES2017): no optional chaining, no ??.
 */

const mgu = require('./kit/mgu');
const { CaptureRecorder } = require('./recorder');
const { CaptureHub } = require('./capture_hub');
const { ProbeController } = require('./probes');

function asciiOnly(str) {
    return String(str === undefined || str === null ? '' : str)
        .replace(/\u00B0/g, ' ')
        .replace(/[^\x20-\x7e]/g, '');
}

function fmtDur(sec) {
    const s = Math.max(0, Math.floor(sec || 0));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return (m < 10 ? '0' + m : String(m)) + ':' + (r < 10 ? '0' + r : String(r));
}

function fmtSpeed(snap, unit) {
    if (unit === 'kmh') {
        return snap.speedKmh !== null ? Math.round(snap.speedKmh) + ' km/h' : '-- km/h';
    }
    return snap.speedMph !== null ? Math.round(snap.speedMph) + ' mph' : '-- mph';
}

function fmtDistMeters(meters, unit) {
    if (typeof meters !== 'number' || !isFinite(meters) || meters <= 0) return '--';
    if (unit === 'kmh') return (meters / 1000).toFixed(1) + ' km';
    return (meters / 1609.344).toFixed(1) + ' mi';
}

function fmtBytes(b) {
    if (!b || b < 1024) return (b || 0) + ' B';
    return (b / 1024).toFixed(1) + ' KB';
}

function shortMode(m) {
    if (!m) return '--';
    return String(m).replace(/^PHEV_/, '').replace(/_/g, ' ');
}

function fmtOpMode(v) {
    if (typeof v !== 'number') return '--';
    return v + ' (0x' + v.toString(16).toUpperCase() + ')';
}

mgu.run({
    async start(ctx) {
        const { ui, settings, signals, log, spec, dataDir } = ctx;

        const recorder = new CaptureRecorder({
            dataDir: dataDir,
            log: log,
            appVersion: spec.version,
        });

        const hub = new CaptureHub({
            signals: signals,
            settings: settings,
            recorder: recorder,
            log: log,
            onSleep: () => {
                if (recorder.active) recorder.stop('vehicle_sleep', hub.snapshot());
                probes.stop();
            },
        });

        const probes = new ProbeController({
            signals: signals,
            hub: hub,
            recorder: recorder,
            settings: settings,
            log: log,
            onChange: () => refreshUi(true),
        });

        hub.start();

        let visibleScreen = 'MAIN';
        let clearConfirmUntil = 0;
        let lastUiMs = 0;
        const rowCache = Object.create(null);

        function setTwoRow(name, r1, r2) {
            const a = asciiOnly(r1);
            const b = asciiOnly(r2);
            const k = a + '\n' + b;
            if (rowCache[name] === k) return;
            rowCache[name] = k;
            ui.cells(name, 0, { Text1stRow: a, Text2ndRow: b });
        }

        function setBtnText(name, text) {
            const a = asciiOnly(text);
            if (rowCache[name] === a) return;
            rowCache[name] = a;
            ui.text(name, a);
        }

        function refreshUi(force) {
            const now = Date.now();
            if (!force && now - lastUiMs < 400) return;
            lastUiMs = now;

            const snap = hub.snapshot(now);
            const st = recorder.status(now);
            const hl = hub.health();
            const unit = settings.get('speedUnit') || 'mph';
            const demoTag = snap.demo ? ' [DEMO]' : '';

            if (visibleScreen === 'MAIN') {
                const recLine = st.active
                    ? 'REC [' + st.phase + '] ' + fmtDur(st.durationSec) + ' | ' + st.events + ' evts | ' + fmtBytes(st.bytes)
                    : 'IDLE' + demoTag + ' | Phase: ' + st.phase + ' | ' + hl.available + '/' + hl.total + ' sigs';
                setTwoRow('ROW_STATUS', 'Capture Status' + (st.capped ? ' (SIZE CAP)' : ''), recLine);

                const iceTxt = snap.iceOn === true ? ('ICE ON' + (snap.rpm ? ' ' + snap.rpm + 'rpm' : ''))
                    : (snap.iceOn === false ? 'EV ONLY' : 'ICE --');
                setTwoRow(
                    'ROW_DRIVE',
                    fmtSpeed(snap, unit) + ' | ' + iceTxt + ' | SoC ' + (snap.socPct !== null ? snap.socPct + '%' : '--'),
                    'Mode: ' + shortMode(snap.driveMode) + ' | Sail: ' + (snap.sailing || '--') + ' | BC: ' + (snap.batteryControl || '--')
                );

                setTwoRow(
                    'ROW_VEM',
                    'VEM: ' + (snap.vemActive || '--') + ' | OpMode: ' + fmtOpMode(snap.opModeHybrid) + ' | Fore: ' + (snap.foresightSit || '--'),
                    'ICE Reason: ' + (snap.iceReason || '--') + ' | VEM Evt: ' + (snap.vemEvent || '--')
                );

                const navSrc = snap.carPlayGuidance ? 'CarPlay ACTIVE'
                    : ((snap.guidingProvider || 'BMW') + ' ' + (snap.guidanceState || 'IDLE'));
                const rcTxt = snap.roadClassFunc !== null ? ('FRC' + snap.roadClassFunc + (snap.urbanFlag ? ' Urban' : ' Hwy')) : 'Road --';
                setTwoRow(
                    'ROW_NAV',
                    navSrc + ' | Dist: ' + fmtDistMeters(snap.destMeters, unit) + ' | ' + rcTxt,
                    'IntelRng: ' + (snap.intelligentRangeActive || '--') + ' | Resync: ' + snap.navResyncCount + ' | eZone: ' + snap.eZoneEvents
                );

                setTwoRow(
                    'BTN_REC',
                    st.active ? 'Stop Recording' : 'Start Recording',
                    st.active ? ('Active: ' + st.sessionName + ' (ICE x' + st.iceTransitions + ', Mark x' + st.markers + ')')
                        : 'Logs all VEM/FES/Hybrid changes + 1 Hz ticks (works in background)'
                );

                setTwoRow('TAB_LIVE', 'Live Signal Monitor', 'Inspect all 16 SOME/IP interfaces in real time');
                setTwoRow(
                    'TAB_PROBES',
                    'Experimental Write Probes',
                    (probes.isArmed() ? 'ARMED' : 'Disarmed') + (probes.routeLoopActive ? ' | Fake Route ON' : '') + ' | Last: ' + probes.lastAction
                );
                const list = recorder.listSessions();
                setTwoRow('TAB_SESSIONS', 'Captures, Export & Settings', list.length + ' file(s) saved | Mirror: ' + (st.mirrorOk ? '/tmp ready' : 'dataDir'));
            }

            if (visibleScreen === 'LIVE') {
                setTwoRow(
                    'LIVE_POWER',
                    'Speed ' + fmtSpeed(snap, unit) + ' | RPM ' + (snap.rpm !== null ? snap.rpm : '--'),
                    'ICE: ' + (snap.iceState || '--') + ' | EV Flag: ' + (snap.evModeFlag === null ? '--' : (snap.evModeFlag ? 'EV' : 'NO')) + ' | eMotor: ' + (snap.eMotorReady === null ? '--' : (snap.eMotorReady ? 'RDY' : 'OFF'))
                );
                setTwoRow(
                    'LIVE_MODE',
                    'Mode: ' + (snap.driveMode || '--') + ' | Sail: ' + (snap.sailing || '--'),
                    'BC: ' + (snap.batteryControl || '--') + ' (avail=' + (snap.availToggleBattCtrl || '--') + ') | PrefEV: ' + (snap.prefElectricDrive || '--')
                );
                setTwoRow(
                    'LIVE_VEM',
                    'VEM: ' + (snap.vemActive || '--') + ' | Evt: ' + (snap.vemEvent || '--'),
                    'Foresight: ' + (snap.foresightSit || '--') + ' (' + (snap.foresightDist || '--') + ') | OpMode: ' + fmtOpMode(snap.opModeHybrid)
                );
                setTwoRow(
                    'LIVE_REASON',
                    'ICE Reason: ' + (snap.iceReason || '--'),
                    'EV Prev1: ' + (snap.evPrevent1 || '--') + ' | Prev2: ' + (snap.evPrevent2 || '--')
                );
                setTwoRow(
                    'LIVE_BATT',
                    'HV SoC: ' + (snap.socPct !== null ? snap.socPct + '%' : '--') + ' | Target: ' + (snap.targetSocDisplay !== null ? snap.targetSocDisplay + '%' : '--'),
                    'EV Range: ' + (snap.rangeElectric !== null ? snap.rangeElectric : '--') + ' | Total: ' + (snap.rangeTotal !== null ? snap.rangeTotal : '--') + ' | IntelRng: ' + (snap.intelligentRangeActive || '--')
                );
                setTwoRow(
                    'LIVE_NAV',
                    'Guide: ' + (snap.guidanceState || '--') + ' (' + (snap.guidingProvider || '--') + ') | CarPlay: ' + (snap.carPlayGuidance ? 'ON' : 'OFF'),
                    'Dist: ' + fmtDistMeters(snap.destMeters, unit) + ' | FRC: ' + (snap.roadClassFunc !== null ? snap.roadClassFunc : '--') + ' | Urban: ' + (snap.urbanFlag === null ? '--' : (snap.urbanFlag ? 'Y' : 'N')) + ' | Lim: ' + (snap.speedLimit !== null ? snap.speedLimit : '--')
                );
                setTwoRow(
                    'LIVE_ADAS',
                    'NavGraph Resync: ' + snap.navResyncCount + ' (last: ' + (snap.navResyncLastSender || 'none') + ')',
                    'eZone Evts: ' + snap.eZoneEvents + ' (dist=' + (snap.eZone1Dist !== null ? snap.eZone1Dist : '--') + ') | TripPwr: ' + (snap.tripForecastPower !== null ? snap.tripForecastPower : '--')
                );
                setTwoRow(
                    'LIVE_HEALTH',
                    'SOME/IP: ' + hl.available + '/' + hl.total + ' ready (' + hl.errors + ' err)' + demoTag,
                    st.active ? ('REC: ' + st.sessionName + ' (' + st.events + ' evts)') : 'Recorder idle'
                );
            }

            if (visibleScreen === 'PROBES') {
                setTwoRow(
                    'ROW_PROBE_STATUS',
                    (probes.isArmed() ? 'ARMED - live bus writes enabled' : 'DISARMED - dry-run only (safe)'),
                    probes.lastAction + ': ' + probes.lastResult
                );
                setTwoRow(
                    'BTN_PROBE_ROUTE',
                    probes.routeLoopActive ? 'Opt 3: STOP Fake KombiIF Route' : 'Opt 3: START Fake KombiIF Route',
                    probes.routeLoopActive ? 'Sending RouteDestinationElectricHybrid (ECO_PRO, 120m) every 2s'
                        : 'Tests if KombiIF.routeDestinationElectricHybrid alone activates VEM/IntelRng'
                );
                setTwoRow(
                    'ROW_PROBE_READBACK',
                    'Mode: ' + shortMode(snap.driveMode) + ' | BC: ' + (snap.batteryControl || '--') + ' | Sail: ' + (snap.sailing || '--'),
                    'PrefEV: ' + (snap.prefElectricDrive || '--') + ' | IntelRng: ' + (snap.intelligentRangeActive || '--') + ' | VEM: ' + (snap.vemActive || '--')
                );
            }

            if (visibleScreen === 'SESSIONS') {
                const list = recorder.listSessions();
                let totalBytes = 0;
                for (let i = 0; i < list.length; i++) totalBytes += list[i].size;
                setTwoRow(
                    'ROW_SESS_CURRENT',
                    'SSH pull: /tmp/hybrid-capture-latest.jsonl',
                    st.sessionName ? ('Latest: ' + st.sessionName + ' (' + fmtBytes(st.bytes) + ')') : 'No active session yet'
                );
                const topNames = list.slice(0, 3).map((x) => x.name.replace(/^capture-/, '').replace(/\.jsonl$/, '') + ' (' + fmtBytes(x.size) + ')').join(', ');
                setTwoRow(
                    'ROW_SESS_LIST',
                    list.length + ' saved capture(s) (' + fmtBytes(totalBytes) + ' total)',
                    topNames || 'None stored in data/captures/'
                );
                setBtnText(
                    'BTN_CLEAR_CAPTURES',
                    now < clearConfirmUntil ? 'Press again to CONFIRM delete all' : 'Clear Saved Captures (2x Press)'
                );
            }
        }

        // Screen visibility tracking
        ui.onVisible((stateName, on) => {
            if (on) {
                visibleScreen = stateName;
                refreshUi(true);
            }
        });

        // MAIN actions
        ui.onClick('BTN_REC', () => {
            if (recorder.active) {
                recorder.stop('manual', hub.snapshot());
            } else {
                recorder.start({ health: hub.health(), initial: hub.snapshot() });
            }
            refreshUi(true);
        });

        ui.onClick('BTN_MARK', () => {
            if (!recorder.active) {
                recorder.start({ autoStartedByMarker: true, initial: hub.snapshot() });
            }
            recorder.recordMarker('user_ice_cutin', hub.snapshot());
            refreshUi(true);
        });

        ui.onClick('BTN_TAG_NONE', () => {
            recorder.setPhase('no_nav', hub.snapshot());
            refreshUi(true);
        });
        ui.onClick('BTN_TAG_BMW', () => {
            recorder.setPhase('bmw_nav_vem', hub.snapshot());
            refreshUi(true);
        });
        ui.onClick('BTN_TAG_CP', () => {
            recorder.setPhase('carplay_nav', hub.snapshot());
            refreshUi(true);
        });

        ui.onClick('TAB_LIVE', () => ui.open('LIVE'));
        ui.onClick('TAB_PROBES', () => ui.open('PROBES'));
        ui.onClick('TAB_SESSIONS', () => ui.open('SESSIONS'));

        // PROBES actions
        ui.onClick('BTN_PROBE_BH_ON', () => probes.probeBatteryControlToggle(true));
        ui.onClick('BTN_PROBE_BH_OFF', () => probes.probeBatteryControlToggle(false));
        ui.onClick('BTN_PROBE_SOC_MATCH', () => probes.probeTargetSocMatch());
        ui.onClick('BTN_PROBE_PREF_OFF', () => probes.probeElectricDrivePreference(false));
        ui.onClick('BTN_PROBE_PREF_ON', () => probes.probeElectricDrivePreference(true));
        ui.onClick('BTN_PROBE_ROUTE', () => probes.toggleFakeRouteForecast());

        // SESSIONS actions
        ui.onClick('BTN_CLEAR_CAPTURES', () => {
            const now = Date.now();
            if (now < clearConfirmUntil) {
                clearConfirmUntil = 0;
                const removed = recorder.clearAll();
                log.info('cleared ' + removed + ' capture file(s)');
            } else {
                clearConfirmUntil = now + 6000;
            }
            refreshUi(true);
        });

        settings.onChange((key, val) => {
            if (key === 'probesArmed' && !val && probes.routeLoopActive) {
                probes.stopFakeRouteForecast('disarmed').catch(() => {});
            }
            refreshUi(true);
        });

        if (settings.get('autoRecord') === true) {
            recorder.start({ autoRecord: true, initial: hub.snapshot() });
        }

        const uiTimer = setInterval(() => refreshUi(false), 500);
        if (uiTimer && typeof uiTimer.unref === 'function') uiTimer.unref();

        process.on('exit', () => {
            clearInterval(uiTimer);
            probes.stop();
            if (recorder.active) recorder.stop('exit', hub.snapshot());
            hub.stop();
        });

        refreshUi(true);
    },
});
