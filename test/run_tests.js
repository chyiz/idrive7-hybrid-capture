#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP_DIR = path.join(ROOT, 'apps', 'hybrid_capture');

const { CaptureRecorder } = require('../apps/hybrid_capture/recorder');
const {
    CaptureHub,
    decodeDriveMode,
    decodeEngineState,
    decodeVemActive,
    decodeBattCtrlState,
    decodePrefEv,
} = require('../apps/hybrid_capture/capture_hub');
const {
    ProbeController,
    buildFesDriveStrategyRequest,
    buildSocHoldRequest,
    buildRouteDestinationRequest,
    targetSocFromCurrent,
    IFACE_FES,
    IFACE_EFF2,
    IFACE_KOMBI,
} = require('../apps/hybrid_capture/probes');
const { parseJsonl, analyzeRecords, formatReport } = require('../scripts/analyze-capture');

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        passed += 1;
        console.log('  PASS  ' + name);
    } catch (e) {
        failed += 1;
        console.error('  FAIL  ' + name + ': ' + (e && e.stack || e));
    }
}

async function run() {
    console.log('Running idrive7-hybrid-capture tests...');

    await test('Node 8.16.2 / ES2017 syntax guard on app files', () => {
        const files = fs.readdirSync(APP_DIR).filter((f) => f.endsWith('.js'));
        assert(files.length >= 4, 'expected app JS files');
        const forbidden = [
            { name: 'optional chaining (?.)', re: /\?\./ },
            { name: 'nullish coalescing (??)', re: /\?\?/ },
            { name: 'optional catch binding (catch {)', re: /\bcatch\s*\{/ },
            { name: 'fs.mkdirSync recursive option', re: /recursive\s*:\s*true/ },
            { name: 'Object.fromEntries', re: /Object\.fromEntries/ },
        ];
        files.forEach((f) => {
            const src = fs.readFileSync(path.join(APP_DIR, f), 'utf8');
            // Strip comments before checking syntax patterns
            const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
            forbidden.forEach((rule) => {
                assert(!rule.re.test(stripped), f + ' contains Node 8 incompatible ' + rule.name);
            });
        });
    });

    await test('app.json manifest integrity, unique loggingId, and SDK platform signals', () => {
        const spec = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'app.json'), 'utf8'));
        assert.strictEqual(spec.id, 'hybrid_capture');
        assert.strictEqual(spec.loggingId, 'OA7F');
        assert.strictEqual(spec.startType, 'manually');
        assert(spec.signals['de.bmw.infotainment.vehicle.Vehicle'].statusNewCurrentUnitsStatusExt === 'rs',
            'Vehicle interface must keep statusNewCurrentUnitsStatusExt for SDK compatibility');
        assert.strictEqual(spec.signals['de.bmw.infotainment.drivingexcitement.FES'].fesDriveStrategy, 'w');
        assert.strictEqual(spec.signals['de.bmw.infotainment.drivingexcitement.Efficiencytainment2'].socHoldConfiguration, 'w');
        assert.strictEqual(spec.signals['de.bmw.infotainment.KombiIF'].routeDestinationElectricHybrid, 'w');
        assert(fs.existsSync(path.join(APP_DIR, 'icon.png')), 'icon.png missing');
        assert(fs.statSync(path.join(APP_DIR, 'icon.png')).size <= 128 * 1024, 'icon exceeds 128 KiB Store limit');
    });

    await test('enum decoders accept both string names and wire numbers', () => {
        assert.strictEqual(decodeDriveMode(18), 'PHEV_HYBRID_ECO');
        assert.strictEqual(decodeDriveMode('PHEV_BATTERYCONTROL'), 'PHEV_BATTERYCONTROL');
        assert.strictEqual(decodeEngineState(0), 'OFF');
        assert.strictEqual(decodeEngineState('MOTOR_LAEUFT'), 'RUNNING');
        assert.strictEqual(decodeVemActive(1), 'ON');
        assert.strictEqual(decodeVemActive('VEM_NICHT_AKTIV_UEBERNOMMEN'), 'OFF');
        assert.strictEqual(decodeBattCtrlState('SOC_HOLD_AKTIV'), 'ON');
        assert.strictEqual(decodeBattCtrlState(0), 'OFF');
        assert.strictEqual(decodePrefEv('FUNKTIONSSCHNITTSTELLE_IST_NICHT_VERFUEGBAR'), 'UNAVAIL');
        assert.strictEqual(decodePrefEv(0), 'OFF');
    });

    await test('CaptureRecorder writes JSONL, mirrors to tmp, caps size, and clears cleanly', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-test-'));
        const mirror = path.join(tmpDir, 'latest.jsonl');
        try {
            const rec = new CaptureRecorder({ dataDir: tmpDir, mirrorPath: mirror, maxFileBytes: 4096, maxSessions: 3 });
            rec.start({ unit: 'test' }, 1000000);
            rec.setPhase('no_nav', { speedMph: 55 }, 1001000);
            rec.recordSignal('Eff2', 'statusSocHoldConfiguration', { statusAdjustVEMVehicle: 1 }, { vemActive: 'ON' }, 1002000);
            rec.recordTick({ speedMph: 56, iceOn: false, sailing: 'COASTING', driveMode: 'PHEV_HYBRID_ECO', vemActive: 'ON' }, 1003000);
            rec.setPhase('bmw_nav_vem', { speedMph: 58 }, 1004000);
            rec.recordIceTransition('start', { speedMph: 58.2, iceOn: true, socPct: 62, driveMode: 'PHEV_HYBRID_ECO', sailing: 'READY', vemActive: 'ON', opModeHybrid: 4, iceReason: 'SYSTEM_REQ', foresightSit: 'PRE_DEST', intelligentRangeActive: 'ACTIVE', roadClassFunc: 0 }, 1005000);
            rec.recordTick({ speedMph: 58.5, iceOn: true, sailing: 'READY', driveMode: 'PHEV_HYBRID_ECO', vemActive: 'ON', opModeHybrid: 4, iceReason: 'SYSTEM_REQ', foresightSit: 'PRE_DEST', intelligentRangeActive: 'ACTIVE', roadClassFunc: 0 }, 1006000);
            rec.recordMarker('user_ice_cutin', { speedMph: 58.5, iceOn: true, driveMode: 'PHEV_HYBRID_ECO', iceReason: 'SYSTEM_REQ', opModeHybrid: 4 }, 1007000);
            rec.stop('manual', { speedMph: 0 }, 1008000);

            assert(fs.existsSync(mirror), 'mirror file missing');
            const parsed = parseJsonl(fs.readFileSync(mirror, 'utf8'));
            assert(parsed.length >= 8, 'expected >= 8 JSONL records');

            const analysis = analyzeRecords(parsed);
            assert.strictEqual(analysis.iceStarts.length, 1);
            assert.strictEqual(analysis.markers.length, 1);
            assert.strictEqual(analysis.phases.bmw_nav_vem.minIceCutInMph, 58.2);
            const report = formatReport(analysis);
            assert(report.indexOf('ICE Cut-In Events') >= 0);
            assert(report.indexOf('58.2mph') >= 0);

            assert.strictEqual(rec.listSessions().length, 1);
            assert.strictEqual(rec.clearAll(), 1);
            assert.strictEqual(rec.listSessions().length, 0);
        } finally {
            // Cleanup temp files
            const walkDel = (p) => {
                if (!fs.existsSync(p)) return;
                if (fs.statSync(p).isDirectory()) {
                    fs.readdirSync(p).forEach((c) => walkDel(path.join(p, c)));
                    fs.rmdirSync(p);
                } else {
                    fs.unlinkSync(p);
                }
            };
            walkDel(tmpDir);
        }
    });

    await test('CaptureHub records live signal transitions and auto-detects ICE start/stop', async () => {
        const handlers = Object.create(null);
        const mockSignals = {
            watch: (iface, inst, h) => {
                handlers[iface] = h;
                return Promise.resolve({ iface: iface, available: true, proxy: { iface: iface } });
            },
            proxy: (iface) => Promise.resolve({ iface: iface }),
            on: () => Promise.resolve(),
            onAvailable: (p, cb) => { cb(true); return Promise.resolve(); },
        };
        const transitions = [];
        const sigs = [];
        const mockRec = {
            active: true,
            recordSignal: (i, f, r, d) => sigs.push({ i: i, f: f, d: d }),
            recordTick: () => {},
            recordIceTransition: (dir, s) => transitions.push({ dir: dir, mph: s.speedMph, reason: s.iceReason }),
        };
        const mockSettings = { get: (k) => (k === 'demo' ? 'off' : null) };
        let sleepFired = false;
        const hub = new CaptureHub({
            signals: mockSignals,
            settings: mockSettings,
            recorder: mockRec,
            onSleep: () => { sleepFired = true; },
        });
        hub.start();
        await new Promise((r) => setTimeout(r, 20));

        handlers['de.bmw.infotainment.vehicle.Vehicle2'].statusCarSpeed2({ speedVehicleCentreOfGravity: Math.round(90 / 0.015625) });
        handlers['de.bmw.powertrain.Powertrain'].StatusCombustionEngine({ statusCombustionEngineDrive: 'MOTOR_STEHT', dummyStatusElectricMode: 'ELECTRICMODE_ACTIVE' });
        handlers['de.bmw.infotainment.drivingexcitement.Efficiencytainment'].statusReasonPowerUpCombustionEngine({ displaySwitchOffPreventionCombustionEngineReason: 'VM_LAEUFT_SYSTEMBEDINGT' });
        handlers['de.bmw.powertrain.Powertrain'].StatusCombustionEngine({ statusCombustionEngineDrive: 'MOTOR_LAEUFT', dummyStatusElectricMode: 'ELECTRICMODE_NOT_ACTIVE' });
        handlers['de.bmw.powertrain.Powertrain'].StatusCombustionEngine({ statusCombustionEngineDrive: 'MOTOR_STEHT', dummyStatusElectricMode: 'ELECTRICMODE_ACTIVE' });
        handlers['de.bmw.infrastructure.VehicleCondition'].VehicleCondition({ statusConditionVehicle: 'PARKEN_BN_IO' });

        assert.strictEqual(transitions.length, 2);
        assert.strictEqual(transitions[0].dir, 'start');
        assert.strictEqual(transitions[0].reason, 'SYSTEM_REQ');
        assert.strictEqual(transitions[1].dir, 'stop');
        assert.strictEqual(sleepFired, true);
        assert(sigs.length >= 3);
        hub.stop();
    });

    await test('ProbeController safety gate, exact BMW defaults, and write execution', async () => {
        let armed = false;
        const writes = [];
        const probeLogs = [];
        let fakeNow = 5000;

        const mockSettings = { get: (k) => (k === 'probesArmed' ? armed : null) };
        const mockSignals = {
            set: (proxy, field, req) => {
                writes.push({ iface: proxy.iface, field: field, req: req });
                return Promise.resolve();
            },
        };
        const mockHub = {
            proxyOf: (iface) => ({ iface: iface }),
            snapshot: () => ({ socPct: 67, driveMode: 'PHEV_HYBRID_ECO', sailing: 'READY', batteryControl: 'OFF', prefElectricDrive: 'UNAVAIL', intelligentRangeActive: 'INACTIVE' }),
        };
        const mockRec = {
            recordProbe: (a, p, r) => probeLogs.push({ a: a, p: p, r: r }),
        };

        // Verify exact struct defaults match G30 catalog
        const fesDef = buildFesDriveStrategyRequest();
        assert.strictEqual(fesDef.operationECOFunctionSailingDrivingExperience, 'SIGNAL_UNGUELTIG');
        assert.strictEqual(fesDef.operationToggleBatteryControl, 'SIGNAL_UNBEFUELLT');
        const socDef = buildSocHoldRequest();
        assert.strictEqual(socDef.operationDestinationSOCBatterysave, 255);
        assert.strictEqual(socDef.operationSoeChargingTarget, 127);
        assert.strictEqual(socDef.operationAdjustVEMVehicle, 'SIGNAL_UNBEFUELLT');
        const routeDef = buildRouteDestinationRequest();
        assert.strictEqual(routeDef.multiplexerForecastRouteDestination, 'SIGNAL_UNGUELTIG');
        assert.strictEqual(routeDef.forecastRouteDurationDestination, 4095);
        assert.strictEqual(targetSocFromCurrent(67), 60);
        assert.strictEqual(targetSocFromCurrent(22), 30);
        assert.strictEqual(targetSocFromCurrent(100), 100);

        const ctrl = new ProbeController({
            signals: mockSignals,
            hub: mockHub,
            recorder: mockRec,
            settings: mockSettings,
            now: () => fakeNow,
        });

        // Disarmed: must block every write
        const blocked = await ctrl.probeBatteryControlToggle(true);
        assert.strictEqual(blocked.ok, false);
        assert.strictEqual(blocked.dryRun, true);
        assert.strictEqual(writes.length, 0);

        // Armed: Option 1 Battery Control toggle + Sailing
        armed = true;
        fakeNow += 2000;
        const r1 = await ctrl.probeBatteryControlToggle(true);
        assert.strictEqual(r1.ok, true);
        assert.strictEqual(writes.length, 1);
        assert.strictEqual(writes[0].iface, IFACE_FES);
        assert.strictEqual(writes[0].field, 'fesDriveStrategy');
        assert.strictEqual(writes[0].req.operationToggleBatteryControl, 'LADEZUSTAND_HALTEN_AKTIVIEREN');
        assert.strictEqual(writes[0].req.operationAdjustSailingVehicle, 'SEGELN_ERLAUBT');
        assert.strictEqual(writes[0].req.operationAdjustEngineSoundVehicle, 'SIGNAL_UNBEFUELLT');

        // Armed: Option 1 Target SoC match (67% -> 60%)
        fakeNow += 2000;
        const r2 = await ctrl.probeTargetSocMatch();
        assert.strictEqual(r2.ok, true);
        assert.strictEqual(writes[1].iface, IFACE_EFF2);
        assert.strictEqual(writes[1].field, 'socHoldConfiguration');
        assert.strictEqual(writes[1].req.operationDestinationSOCBatterysave, 60);
        assert.strictEqual(writes[1].req.operationAdjustVEMVehicle, 'SIGNAL_UNBEFUELLT');

        // Armed: Option 3 Fake KombiIF Route Forecast start + stop
        fakeNow += 2000;
        const r3 = await ctrl.toggleFakeRouteForecast();
        assert.strictEqual(r3.ok, true);
        assert.strictEqual(ctrl.routeLoopActive, true);
        assert.strictEqual(writes[2].iface, IFACE_KOMBI);
        assert.strictEqual(writes[2].field, 'routeDestinationElectricHybrid');
        assert.strictEqual(writes[2].req.multiplexerForecastRouteDestination, 'ECO_PRO');
        assert.strictEqual(writes[2].req.operationIntelligentRangeDisplay, 1);

        await ctrl.stopFakeRouteForecast('test');
        assert.strictEqual(ctrl.routeLoopActive, false);
        assert.strictEqual(writes[3].req.multiplexerForecastRouteDestination, 'SIGNAL_UNGUELTIG');
        ctrl.stop();
    });

    console.log('\nTests: ' + passed + ' passed, ' + failed + ' failed');
    if (failed > 0) process.exit(1);
}

run();
