'use strict';
/**
 * probes.js - Safety-gated experimental SOME/IP write probes for Option 1 & Option 3.
 *
 * Ships DISARMED by default (`settings.get('probesArmed') === false`).
 * While disarmed, every button logs a dry-run preview without touching the bus.
 *
 * All struct member names, enum strings, and unfilled defaults are verified
 * directly against BMW G30 530e `someip-interfaces.json`:
 *   - de.bmw.infotainment.drivingexcitement.FES (0xb50d) -> fesDriveStrategy (setter 291)
 *   - de.bmw.infotainment.drivingexcitement.Efficiencytainment2 (0xb517) -> socHoldConfiguration (setter 21)
 *   - de.bmw.infotainment.KombiIF (0xb51b) -> routeDestinationElectricHybrid (setter 41)
 *
 * Strict Node 8.16.2 (ES2017): no optional chaining, no ??.
 */

const IFACE_FES = 'de.bmw.infotainment.drivingexcitement.FES';
const IFACE_EFF2 = 'de.bmw.infotainment.drivingexcitement.Efficiencytainment2';
const IFACE_KOMBI = 'de.bmw.infotainment.KombiIF';

const MIN_GAP_MS = 1000;
const ROUTE_REPEAT_MS = 2000;
const READBACK_DELAY_MS = 1800;

/**
 * Base ControlFESDriveStrategyWrapper with every member set to its exact
 * catalog default (SIGNAL_UNGUELTIG for the first 5 fields, SIGNAL_UNBEFUELLT
 * for the remaining 8) so unrelated settings are untouched.
 */
function buildFesDriveStrategyRequest(overrides) {
    return Object.assign({
        operationECOFunctionSailingDrivingExperience: 'SIGNAL_UNGUELTIG',
        operationECOFunctionMSADrivingExperience: 'SIGNAL_UNGUELTIG',
        operationSportFunctionShiftAssistantDrivingExperience: 'SIGNAL_UNGUELTIG',
        operationSportClusterRPMPathDrivingExperience: 'SIGNAL_UNGUELTIG',
        operationSportClusterGroupEngineDrivingExperience: 'SIGNAL_UNGUELTIG',
        operationIndividualisationResetDriveDrivingExperience: 'SIGNAL_UNBEFUELLT',
        operationAdjustSailingVehicle: 'SIGNAL_UNBEFUELLT',
        operationAdjustEngineSoundVehicle: 'SIGNAL_UNBEFUELLT',
        operationEfficiencyTrainer: 'SIGNAL_UNBEFUELLT',
        operationToggleBatteryControl: 'SIGNAL_UNBEFUELLT',
        operationSetupPreferenceElectricDriveDriving: 'SIGNAL_UNBEFUELLT',
        statusMSAActivation: 'SIGNAL_UNBEFUELLT',
        operationToggleElectricMode: 'SIGNAL_UNBEFUELLT',
    }, overrides || {});
}

/**
 * Base OperationSetupSOCHoldWrapper with every member set to its exact catalog
 * default (255 / 127 / SIGNAL_UNBEFUELLT) so VEM and charging configs stay intact.
 */
function buildSocHoldRequest(overrides) {
    return Object.assign({
        operationDestinationSOCBatterysave: 255,
        operationSetupRecuperationLevel: 'SIGNAL_UNBEFUELLT',
        operationAdjustVEMVehicle: 'SIGNAL_UNBEFUELLT',
        operationSetupStartupModusElectricVehicle: 'SIGNAL_UNBEFUELLT',
        operationChargeControlPlug: 'SIGNAL_UNBEFUELLT',
        operationChargeControlFlap: 'SIGNAL_UNBEFUELLT',
        operationSoeChargingTarget: 127,
        operationAcCurrentLimit: 'SIGNAL_UNBEFUELLT',
        operationChargeAcousticLimit: 'SIGNAL_UNBEFUELLT',
        operationChargeDCBoost: 'SIGNAL_UNBEFUELLT',
        operationSoeChargingTargetStatus: 'SIGNAL_UNBEFUELLT',
    }, overrides || {});
}

/**
 * Base RouteDestinationElectricHybridWrapper (KombiIF setter 41).
 * `clear` sets all fields back to invalid/unfilled defaults.
 */
function buildRouteDestinationRequest(overrides) {
    return Object.assign({
        operationMessageRouteChange: 15,
        multiplexerForecastRouteDestination: 'SIGNAL_UNGUELTIG',
        forecastRouteDurationDestination: 4095,
        forecastRouteAverageSpeed: 4095,
        forecastRouteAverageConsumptionTraction: 255,
        operationIntelligentRangeDisplay: 0,
    }, overrides || {});
}

/** Round live HV SoC down to nearest 10%, clamped to BMW Battery Control range 30..100. */
function targetSocFromCurrent(socPct) {
    if (typeof socPct !== 'number' || !isFinite(socPct)) return 30;
    const rounded = Math.floor(socPct / 10) * 10;
    return Math.max(30, Math.min(100, rounded));
}

class ProbeController {
    constructor(opts) {
        const o = opts || {};
        this.signals = o.signals;
        this.hub = o.hub;
        this.recorder = o.recorder;
        this.settings = o.settings;
        this.log = o.log || { info: () => {}, warn: () => {}, error: () => {} };
        this.now = o.now || Date.now;
        this.onChange = o.onChange || (() => {});

        this.lastWriteMs = 0;
        this.lastAction = 'None';
        this.lastResult = 'Disarmed (safe)';
        this.routeLoopActive = false;
        this._routeTimer = null;
        this._readbackTimer = null;
        this._routeSeq = 0;
    }

    isArmed() {
        return Boolean(this.settings && this.settings.get('probesArmed') === true);
    }

    _record(action, payload, result) {
        this.lastAction = action;
        this.lastResult = result;
        const snap = this.hub ? this.hub.snapshot(this.now()) : null;
        if (this.recorder) this.recorder.recordProbe(action, payload, result, snap, this.now());
        this.log.info('probe [' + action + ']: ' + result);
        this.onChange();
    }

    _scheduleReadback(action) {
        if (this._readbackTimer) clearTimeout(this._readbackTimer);
        this._readbackTimer = setTimeout(() => {
            this._readbackTimer = null;
            const snap = this.hub ? this.hub.snapshot(this.now()) : null;
            if (!snap) return;
            const summary = 'mode=' + (snap.driveMode || '?') +
                ' bc=' + (snap.batteryControl || '?') +
                ' sail=' + (snap.sailing || '?') +
                ' prefEV=' + (snap.prefElectricDrive || '?') +
                ' intelRng=' + (snap.intelligentRangeActive || '?');
            if (this.recorder) this.recorder.recordProbe(action + '_readback', null, summary, snap, this.now());
            this.lastResult = 'OK -> ' + summary;
            this.onChange();
        }, READBACK_DELAY_MS);
        if (this._readbackTimer && typeof this._readbackTimer.unref === 'function') this._readbackTimer.unref();
    }

    async _send(action, iface, field, payload) {
        if (!this.isArmed()) {
            this._record(action, payload, 'BLOCKED: disarmed (enable Arm Write Probes)');
            return { ok: false, dryRun: true, reason: 'disarmed' };
        }
        const elapsed = this.now() - this.lastWriteMs;
        if (elapsed < MIN_GAP_MS) {
            this._record(action, payload, 'RATE LIMITED (wait 1s)');
            return { ok: false, reason: 'rate_limit' };
        }
        const proxy = this.hub ? this.hub.proxyOf(iface) : null;
        if (!proxy || !this.signals || typeof this.signals.set !== 'function') {
            this._record(action, payload, 'ERR: proxy unavailable for ' + iface.split('.').pop());
            return { ok: false, reason: 'no_proxy' };
        }

        this.lastWriteMs = this.now();
        try {
            await this.signals.set(proxy, field, payload, 4000);
            this._record(action, payload, 'SENT -> awaiting readback...');
            this._scheduleReadback(action);
            return { ok: true };
        } catch (e) {
            const msg = String(e && e.message || e);
            this._record(action, payload, 'ERR: ' + msg);
            return { ok: false, error: msg };
        }
    }

    /** Option 1A: Toggle orthogonal Battery Control + explicitly request sailing allowed. */
    async probeBatteryControlToggle(enable) {
        const req = buildFesDriveStrategyRequest({
            operationToggleBatteryControl: enable ? 'LADEZUSTAND_HALTEN_AKTIVIEREN' : 'LADEZUSTAND_HALTEN_DEAKTIVIEREN',
            operationAdjustSailingVehicle: enable ? 'SEGELN_ERLAUBT' : 'SIGNAL_UNBEFUELLT',
            operationECOFunctionSailingDrivingExperience: enable ? 'SEGELN_AN' : 'SIGNAL_UNGUELTIG',
        });
        return this._send(enable ? 'opt1_battctrl_on_sail' : 'opt1_battctrl_off', IFACE_FES, 'fesDriveStrategy', req);
    }

    /** Option 1B: Match Battery Control target SoC to current HV SoC (rounded down to 10%, min 30%). */
    async probeTargetSocMatch() {
        const snap = this.hub ? this.hub.snapshot(this.now()) : {};
        const target = targetSocFromCurrent(snap.socPct);
        const req = buildSocHoldRequest({
            operationDestinationSOCBatterysave: target,
        });
        return this._send('opt1_soc_target_' + target, IFACE_EFF2, 'socHoldConfiguration', req);
    }

    /** Option 1C: Toggle operationSetupPreferenceElectricDriveDriving (AUS vs AN). */
    async probeElectricDrivePreference(enable) {
        const req = buildFesDriveStrategyRequest({
            operationSetupPreferenceElectricDriveDriving: enable ? 'AN' : 'AUS',
        });
        return this._send(enable ? 'opt1_pref_ev_an' : 'opt1_pref_ev_aus', IFACE_FES, 'fesDriveStrategy', req);
    }

    /** Option 3 minimal test: toggle synthetic KombiIF.routeDestinationElectricHybrid broadcast. */
    async toggleFakeRouteForecast() {
        if (this.routeLoopActive) {
            return this.stopFakeRouteForecast('manual');
        }
        if (!this.isArmed()) {
            this._record('opt3_route_forecast_on', null, 'BLOCKED: disarmed (enable Arm Write Probes)');
            return { ok: false, dryRun: true };
        }
        this.routeLoopActive = true;
        this._routeSeq = 0;
        const sendOnce = async () => {
            if (!this.routeLoopActive || !this.isArmed()) {
                this.stopFakeRouteForecast('disarmed');
                return;
            }
            this._routeSeq = (this._routeSeq + 1) & 0x07;
            const req = buildRouteDestinationRequest({
                operationMessageRouteChange: this._routeSeq === 0 ? 1 : this._routeSeq,
                multiplexerForecastRouteDestination: 'ECO_PRO',
                forecastRouteDurationDestination: 120,   // ~120 min far trip
                forecastRouteAverageSpeed: 100,          // ~100 km/h highway avg
                forecastRouteAverageConsumptionTraction: 22,
                operationIntelligentRangeDisplay: 1,
            });
            const proxy = this.hub ? this.hub.proxyOf(IFACE_KOMBI) : null;
            if (!proxy || !this.signals || typeof this.signals.set !== 'function') {
                this._record('opt3_route_forecast_tick', req, 'ERR: KombiIF proxy unavailable');
                this.routeLoopActive = false;
                return;
            }
            try {
                await this.signals.set(proxy, 'routeDestinationElectricHybrid', req, 4000);
                if (this._routeSeq === 1) {
                    this._record('opt3_route_forecast_on', req, 'ACTIVE (sending every 2s)');
                    this._scheduleReadback('opt3_route_forecast_on');
                }
            } catch (e) {
                const msg = String(e && e.message || e);
                this._record('opt3_route_forecast_err', req, 'ERR: ' + msg);
                this.routeLoopActive = false;
                if (this._routeTimer) { clearInterval(this._routeTimer); this._routeTimer = null; }
            }
        };

        await sendOnce();
        if (this.routeLoopActive) {
            this._routeTimer = setInterval(() => { sendOnce().catch(() => {}); }, ROUTE_REPEAT_MS);
            if (this._routeTimer && typeof this._routeTimer.unref === 'function') this._routeTimer.unref();
        }
        this.onChange();
        return { ok: this.routeLoopActive };
    }

    async stopFakeRouteForecast(reason) {
        const wasActive = this.routeLoopActive;
        this.routeLoopActive = false;
        if (this._routeTimer) {
            clearInterval(this._routeTimer);
            this._routeTimer = null;
        }
        if (!wasActive) return { ok: true };
        const clearReq = buildRouteDestinationRequest();
        const proxy = this.hub ? this.hub.proxyOf(IFACE_KOMBI) : null;
        if (proxy && this.signals && typeof this.signals.set === 'function' && this.isArmed()) {
            try {
                await this.signals.set(proxy, 'routeDestinationElectricHybrid', clearReq, 3000);
            } catch (e) { /* ignore on stop */ }
        }
        this._record('opt3_route_forecast_off', clearReq, 'STOPPED (' + (reason || 'manual') + ')');
        return { ok: true };
    }

    stop() {
        if (this._readbackTimer) { clearTimeout(this._readbackTimer); this._readbackTimer = null; }
        if (this.routeLoopActive) {
            this.stopFakeRouteForecast('shutdown').catch(() => {});
        }
    }
}

module.exports = {
    ProbeController,
    buildFesDriveStrategyRequest,
    buildSocHoldRequest,
    buildRouteDestinationRequest,
    targetSocFromCurrent,
    IFACE_FES,
    IFACE_EFF2,
    IFACE_KOMBI,
};
