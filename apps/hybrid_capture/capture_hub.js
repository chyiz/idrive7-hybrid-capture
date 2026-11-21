'use strict';
/**
 * capture_hub.js - SOME/IP subscription hub for BMW iDrive 7 PHEV / VEM capture.
 *
 * Subscribes to all 16 vehicle, powertrain, FES, Efficiencytainment, KombiIF,
 * NavGraph2 resync, ConnectedForesight (EDriveZones), Guidance, CarPlay, and
 * ADASNG CCP map-matcher interfaces, normalizes enums/scalings, detects ICE
 * cut-in/cut-out transitions, and feeds the CaptureRecorder.
 *
 * Strict Node 8.16.2 (ES2017): no optional chaining, no ??.
 */

const KMH_TO_MPH = 0.6213711922;
const ICE_RPM_THRESHOLD = 400;

const DRIVE_MODES = {
    0: 'INIT', 1: 'SPORT', 2: 'SPORT_EXPERT', 3: 'SPORT_IND', 4: 'COMFORT',
    5: 'COMFORT_PLUS', 6: 'COMFORT_IND', 7: 'ECO_PRO', 8: 'ECO_PRO_PLUS',
    9: 'ECO_PRO_IND', 10: 'ADAPTIVE',
    15: 'PHEV_SPORT', 16: 'PHEV_SPORT_IND', 17: 'PHEV_HYBRID', 18: 'PHEV_HYBRID_ECO',
    19: 'PHEV_HYBRID_COMFORT', 20: 'PHEV_ELECTRIC', 21: 'PHEV_ELECTRIC_IND',
    22: 'PHEV_BATTERYCONTROL', 23: 'PHEV_SPORT_PLUS', 28: 'BOOST',
};

const SAILING_STATES = {
    0: 'NOT_POSSIBLE', 1: 'READY', 2: 'ENTERING', 3: 'COASTING', 4: 'EXITING', 5: 'BRAKED_SAIL',
    13: 'UNAVAIL', 14: 'ERROR', 15: 'UNFILLED',
};

const SAILING_BY_NAME = {
    SEGELN_NICHT_MOEGLICH: 'NOT_POSSIBLE',
    SEGELN_MOEGLICH_PASSIV: 'READY',
    UEBERGANG_IN_SEGELN: 'ENTERING',
    SEGELN_AKTIV: 'COASTING',
    UEBERGANG_AUS_SEGELN: 'EXITING',
    GEBREMSTES_SEGELN: 'BRAKED_SAIL',
};

const ICE_REASONS = {
    0: 'NONE', 1: 'DRIVER_FORCED', 2: 'COMFORT_REQ', 3: 'BATTERY_SOC',
    4: 'LOW_ENG_TEMP', 5: 'HIGH_ENG_TEMP', 6: 'LOW_HV_TEMP', 7: 'HIGH_HYBRID_TEMP',
    8: 'SYSTEM_REQ', 9: 'LOW_AMB_TEMP', 10: 'HIGH_AMB_TEMP', 11: 'TRAFFIC_SITUATION',
    12: 'LEAD_VEHICLE', 13: 'STOP_SIGN', 14: 'YIELD_SIGN', 15: 'SLOW_ZONE',
    16: 'ROUNDABOUT', 17: 'TURN_DETECTED', 18: 'TRAFFIC_LIGHT', 19: 'HIGHWAY_ONRAMP',
    20: 'PARKING_DEST_ZONE', 255: 'INVALID',
};

const ICE_REASON_BY_NAME = {
    KEIN_ENGOFFPROHIBITOR: 'NONE',
    MOTORSTART_WURDE_DURCH_FAHRER_ERZWUNGEN: 'DRIVER_FORCED',
    VM_LAEUFT_WEGEN_KOMFORTANFORDERUNG: 'COMFORT_REQ',
    VM_LAEUFT_WEGEN_BATTERIELADEZUSTAND: 'BATTERY_SOC',
    VM_LAEUFT_WEGEN_NIEDRIGER_MOTORTEMPERATUR: 'LOW_ENG_TEMP',
    VM_LAEUFT_WEGEN_HOHER_MOTORTEMPERATUR: 'HIGH_ENG_TEMP',
    VM_LAEUFT_WEGEN_GERINGER_TEMPERATUR_HOCHVOLTBATTERIE: 'LOW_HV_TEMP',
    VM_LAEUFT_WEGEN_HOHER_TEMPERATUR_IM_HYBRIDSYSTEM: 'HIGH_HYBRID_TEMP',
    VM_LAEUFT_SYSTEMBEDINGT: 'SYSTEM_REQ',
    VM_LAEUFT_WEGEN_NIEDRIGER_AUSSENTEMPERATUR: 'LOW_AMB_TEMP',
    VM_LAEUFT_WEGEN_HOHER_AUSSENTEMPERATUR: 'HIGH_AMB_TEMP',
    VM_LAEUFT_WEGEN_ERKANNTER_VERKEHRSSITUATION: 'TRAFFIC_SITUATION',
    VM_LAEUFT_WEGEN_VORDERFAHRZEUG: 'LEAD_VEHICLE',
    VM_LAEUFT_WEGEN_STOPPSCHILD_ERKANNT: 'STOP_SIGN',
    VM_LAEUFT_WEGEN_VORFAHRT_ACHTEN_ERKANNT: 'YIELD_SIGN',
    VM_LAEUFT_WEGEN_LANGSAMFAHRZONE_ERKANNT: 'SLOW_ZONE',
    VM_LAEUFT_WEGEN_KREISVERKEHR_ERKANNT: 'ROUNDABOUT',
    VM_LAEUFT_WEGEN_ABBIEGEWUNSCH_ERKANNT: 'TURN_DETECTED',
    VM_LAEUFT_WEGEN_AMPEL_ERKANNT: 'TRAFFIC_LIGHT',
    VM_LAEUFT_WEGEN_AUTOBAHNAUFFAHRT__S__BESCHLEUNIGUNGSSTREIFEN_ERKANNT: 'HIGHWAY_ONRAMP',
    VM_LAEUFT_WEGEN_PARKPLATZSUCHE__S__ZIELZONE_ERKANNT: 'PARKING_DEST_ZONE',
};

const FORESIGHT_SIT = {
    0: 'NONE', 1: 'DEST', 2: 'DOWNHILL', 3: 'EDRIVE_ZONE', 4: 'PRE_EDRIVE_ZONE',
    5: 'PRE_DOWNHILL', 6: 'PRE_ZERO_EMISSION', 7: 'PRE_DEST', 8: 'PRE_SLOW_ZONE',
    9: 'ZERO_EMISSION', 10: 'SLOW_ZONE', 11: 'PRE_EFAHRZONE', 12: 'EFAHRZONE',
    13: 'UNAVAIL', 14: 'ERROR', 15: 'UNFILLED',
};

const FORESIGHT_BY_NAME = {
    KEINE_ANZEIGE: 'NONE', SITUATION_ZIEL: 'DEST', SITUATION_GEFAELLE: 'DOWNHILL',
    SITUATION_EDRIVE_ZONE: 'EDRIVE_ZONE', ANKUENDIGUNG_EDRIVE_ZONE: 'PRE_EDRIVE_ZONE',
    ANKUENDIGUNG_GEFAELLE: 'PRE_DOWNHILL', ANKUENDIGUNG_ZERO_EMISSION_ZONE: 'PRE_ZERO_EMISSION',
    ANKUENDIGUNG_ZIEL: 'PRE_DEST', ANKUENDIGUNG_LANGSAM_FAHRGEBIET_WOHNGEBIET: 'PRE_SLOW_ZONE',
    SITUATION_ZERO_EMISSION_ZONE: 'ZERO_EMISSION', SITUATION_LANGSAM_FAHRGEBIET_WOHNGEBIET: 'SLOW_ZONE',
    ANKUENDIGUNG_EFAHRZONE: 'PRE_EFAHRZONE', SITUATION_EFAHRZONE: 'EFAHRZONE',
};

const VEM_EVENT = {
    0: 'NO_ACTION',
    1: 'DEACT_EV_LOW_RANGE',
    2: 'DEACT_EV_PRE_ZEZ',
    3: 'PREVENT_EV_PRE_ZEZ',
    13: 'UNAVAIL', 14: 'ERROR', 15: 'UNFILLED',
};

const VEM_EVENT_BY_NAME = {
    NO_ACTION: 'NO_ACTION',
    DEACTIVATE_ELECTRIC_INSUFFICIENT_ELECTRIC_RANGE: 'DEACT_EV_LOW_RANGE',
    DEACTIVATE_ELECTRIC_IN_EDRIVEZONE_PREPARATION_ZEROEMISSIONZONE: 'DEACT_EV_PRE_ZEZ',
    PREVENT_ACTIVATION_ELECTRIC_ENTRY_EDRIVEZONE_PREPARATION_ZEROEMISSIONZONE: 'PREVENT_EV_PRE_ZEZ',
};

const EV_PREVENT = {
    0: 'NONE', 1: 'SYSTEM', 2: 'SPEED_HIGH', 3: 'POWER_HIGH', 4: 'SOC_LOW', 5: 'GEAR_S',
    9: 'BSAVE_SYSTEM', 10: 'BSAVE_LOW_FUEL', 11: 'BSAVE_SOC_HIGH', 12: 'BSAVE_GEAR_MS', 15: 'INVALID',
};

const RESYNC_SENDERS = {
    0: 'LDM', 24: 'EGS', 28: 'ICM_QL', 87: 'NIVI', 93: 'KAFAS', 95: 'FLA',
    114: 'FRMFA', 115: 'DME', 116: 'EME', 117: 'ICAM2',
};

const GUIDANCE_STATES = { 0: 'INACTIVE', 1: 'CALCULATING', 2: 'ACTIVE' };
const GUIDING_PROVIDERS = { 0: 'BMW', 1: 'CARPLAY', 2: 'ANDROID_AUTO', 3: 'CARLIFE', 4: 'OTHER' };
const ENGINE_STATES = { 0: 'OFF', 1: 'STARTING', 2: 'RUNNING', 3: 'STOPPING' };

function mapEnum(raw, numMap, nameMap) {
    if (raw === undefined || raw === null) return null;
    if (typeof raw === 'number') {
        return numMap[raw] !== undefined ? numMap[raw] : String(raw);
    }
    const s = String(raw).trim();
    if (/^\d+$/.test(s)) {
        const n = Number(s);
        return numMap[n] !== undefined ? numMap[n] : s;
    }
    const u = s.toUpperCase();
    if (nameMap && nameMap[u] !== undefined) return nameMap[u];
    return u;
}

function decodeDriveMode(raw) {
    if (raw === undefined || raw === null) return null;
    if (typeof raw === 'number') return DRIVE_MODES[raw] || ('MODE_' + raw);
    const s = String(raw).trim();
    if (/^\d+$/.test(s)) return DRIVE_MODES[Number(s)] || ('MODE_' + s);
    return s.toUpperCase();
}

function decodeEngineState(raw) {
    if (raw === undefined || raw === null) return null;
    if (typeof raw === 'number') return ENGINE_STATES[raw] || String(raw);
    const u = String(raw).toUpperCase();
    if (u === 'MOTOR_STEHT' || u === 'MOTOR_AUS' || u === '0') return 'OFF';
    if (u === 'MOTOR_STARTET' || u === '1') return 'STARTING';
    if (u === 'MOTOR_LAEUFT' || u === '2') return 'RUNNING';
    if (u === 'MOTOR_IM_AUSLAUF' || u === '3') return 'STOPPING';
    return u;
}

function decodeVemActive(raw) {
    if (raw === undefined || raw === null) return null;
    if (raw === 1 || raw === '1' || String(raw).toUpperCase() === 'VEM_AKTIV_UEBERNOMMEN') return 'ON';
    if (raw === 0 || raw === '0' || String(raw).toUpperCase() === 'VEM_NICHT_AKTIV_UEBERNOMMEN') return 'OFF';
    return String(raw);
}

function decodeBattCtrlState(raw) {
    if (raw === undefined || raw === null) return null;
    if (raw === 1 || raw === '1' || String(raw).toUpperCase() === 'SOC_HOLD_AKTIV') return 'ON';
    if (raw === 0 || raw === '0' || String(raw).toUpperCase() === 'SOC_HOLD_NICHT_AKTIV') return 'OFF';
    return String(raw);
}

function decodePrefEv(raw) {
    if (raw === undefined || raw === null) return null;
    const u = String(raw).toUpperCase();
    if (raw === 1 || u === '1' || u === 'AN') return 'ON';
    if (raw === 0 || u === '0' || u === 'AUS') return 'OFF';
    if (raw === 13 || u === '13' || u.indexOf('NICHT_VERFUEGBAR') >= 0) return 'UNAVAIL';
    if (raw === 14 || u === '14' || u.indexOf('FEHLER') >= 0) return 'ERROR';
    if (raw === 15 || u === '15' || u.indexOf('UNBEFUELLT') >= 0) return 'UNFILLED';
    return u;
}

function decodeBoolFlag(raw, trueName, falseName) {
    if (raw === undefined || raw === null) return null;
    if (typeof raw === 'boolean') return raw;
    const u = String(raw).toUpperCase();
    if (raw === 1 || u === '1' || (trueName && u === trueName)) return true;
    if (raw === 0 || u === '0' || (falseName && u === falseName)) return false;
    return null;
}

function extractRoadText(desc) {
    if (!desc) return null;
    if (typeof desc === 'string') return desc;
    const els = Array.isArray(desc.elements) ? desc.elements : (Array.isArray(desc) ? desc : null);
    if (!els) return null;
    const parts = [];
    for (let i = 0; i < els.length; i++) {
        const el = els[i];
        if (!el) continue;
        if (typeof el === 'string') parts.push(el);
        else if (el.text) parts.push(String(el.text));
        else if (el.value) parts.push(String(el.value));
    }
    return parts.length ? parts.join(' ').trim() : null;
}

function extractDestMeters(info) {
    if (!info || typeof info !== 'object') return null;
    if (typeof info.distanceFromCurrentToFinalDestination === 'number' && isFinite(info.distanceFromCurrentToFinalDestination) && info.distanceFromCurrentToFinalDestination > 0) {
        return info.distanceFromCurrentToFinalDestination;
    }
    const fd = info.formattedDistance;
    if (fd && typeof fd.rawDistance === 'number' && isFinite(fd.rawDistance) && fd.rawDistance > 0) {
        return fd.rawDistance;
    }
    return null;
}

function safeJsonKey(v) {
    try { return JSON.stringify(v); } catch (e) { return String(v); }
}

class CaptureHub {
    constructor(opts) {
        const o = opts || {};
        this.signals = o.signals;
        this.settings = o.settings;
        this.recorder = o.recorder;
        this.log = o.log || { info: () => {}, warn: () => {}, error: () => {} };
        this.now = o.now || Date.now;
        this.onSleep = o.onSleep || (() => {});

        this.proxies = Object.create(null);
        this.subs = [];
        this.proxyStatus = Object.create(null);
        this.live = {};
        this.rawSigCache = Object.create(null);
        this.lastRealMs = 0;
        this.startedAt = this.now();
        this.demoActive = false;
        this._iceRunning = null;
        this._demoTimer = null;
        this._tickTimer = null;
        this._demoT0 = this.now();
    }

    proxyOf(iface) {
        return this.proxies[iface] || null;
    }

    carPresent() {
        if (this.lastRealMs > 0) return true;
        const keys = Object.keys(this.proxyStatus);
        for (let i = 0; i < keys.length; i++) {
            if (this.proxyStatus[keys[i]] && this.proxyStatus[keys[i]].available) return true;
        }
        return false;
    }

    wantDemo(nowMs) {
        const now = typeof nowMs === 'number' ? nowMs : this.now();
        const mode = this.settings ? this.settings.get('demo') : 'auto';
        if (mode === 'on') return true;
        if (mode === 'off') return false;
        return !this.carPresent() && (now - this.startedAt > 5000);
    }

    _markReal(nowMs) {
        this.lastRealMs = typeof nowMs === 'number' ? nowMs : this.now();
        this.demoActive = false;
    }

    /** Record raw+decoded signal event only when payload actually changed. */
    _onSignal(ifaceShort, field, raw, decoded, opts) {
        const now = this.now();
        this._markReal(now);
        const key = ifaceShort + '.' + field;
        const sig = safeJsonKey(raw);
        const highRate = opts && opts.highRate;
        if (!highRate && this.rawSigCache[key] !== sig) {
            this.rawSigCache[key] = sig;
            if (this.recorder && this.recorder.active) {
                this.recorder.recordSignal(ifaceShort, field, raw, decoded, now);
            }
        }
        this._checkIceTransition(now);
    }

    _computeIceOn(s) {
        if (s.iceState === 'RUNNING' || s.iceState === 'STARTING') return true;
        if (s.iceState === 'OFF') return false;
        if (s.cdsEngineState === 'RUNNING' || s.cdsEngineState === 'STARTING') return true;
        if (s.cdsEngineState === 'OFF') return false;
        if (typeof s.rpm === 'number') return s.rpm >= ICE_RPM_THRESHOLD;
        return null;
    }

    _checkIceTransition(nowMs) {
        const snap = this.snapshot(nowMs);
        const iceNow = snap.iceOn;
        if (iceNow === null) return;
        if (this._iceRunning === null) {
            this._iceRunning = iceNow;
            return;
        }
        if (iceNow !== this._iceRunning) {
            const dir = iceNow ? 'start' : 'stop';
            this._iceRunning = iceNow;
            if (this.recorder && this.recorder.active) {
                this.recorder.recordIceTransition(dir, snap, nowMs);
            }
            this.log.info('ICE ' + dir.toUpperCase() + ' at ' +
                (snap.speedMph !== null ? snap.speedMph.toFixed(1) + ' mph' : '? mph') +
                ' mode=' + (snap.driveMode || '?') +
                ' vem=' + (snap.vemActive || '?') +
                ' reason=' + (snap.iceReason || '?') +
                ' opMode=' + (snap.opModeHybrid !== null ? snap.opModeHybrid : '?'));
        }
    }

    start() {
        const self = this;

        function watch(iface, inst, handlers) {
            const shortName = iface.split('.').pop();
            self.proxyStatus[shortName] = { iface: iface, available: false, error: null };
            if (!self.signals || typeof self.signals.watch !== 'function') {
                self.proxyStatus[shortName].error = 'no native someip';
                return;
            }
            self.signals.watch(iface, inst || '1', handlers, self.log).then((sub) => {
                self.subs.push(sub);
                if (sub && sub.proxy) self.proxies[iface] = sub.proxy;
                self.proxyStatus[shortName] = {
                    iface: iface,
                    available: Boolean(sub && sub.available),
                    error: sub && sub.error ? String(sub.error) : null,
                };
                if (sub && sub.proxy && typeof self.signals.onAvailable === 'function') {
                    self.signals.onAvailable(sub.proxy, (avail) => {
                        self.proxyStatus[shortName].available = Boolean(avail);
                    }).catch(() => {});
                }
            }).catch((e) => {
                self.proxyStatus[shortName].error = String(e && e.message || e);
            });
        }

        function watchBroadcasts(iface, inst, events) {
            const shortName = iface.split('.').pop();
            self.proxyStatus[shortName] = { iface: iface, available: false, error: null };
            if (!self.signals || typeof self.signals.proxy !== 'function') {
                self.proxyStatus[shortName].error = 'no native someip';
                return;
            }
            self.signals.proxy(iface, inst || '1').then((p) => {
                self.proxies[iface] = p;
                self.subs.push({ iface: iface, proxy: p, shutdown: () => Promise.resolve().then(() => p.shutdown && p.shutdown()).catch(() => {}) });
                self.signals.onAvailable(p, (avail) => {
                    self.proxyStatus[shortName].available = Boolean(avail);
                }).catch(() => {});
                Object.keys(events).forEach((evName) => {
                    self.signals.on(p, evName, events[evName], self.log).catch((e) => {
                        self.log.warn(shortName + '.' + evName + ': ' + e);
                    });
                });
            }).catch((e) => {
                self.proxyStatus[shortName].error = String(e && e.message || e);
            });
        }

        // 1. Efficiencytainment2 (0xb517) - VEM, Foresight, Operating Mode, HV SoC
        watch('de.bmw.infotainment.drivingexcitement.Efficiencytainment2', '1', {
            statusSocHoldConfiguration: (v) => {
                if (!v || typeof v !== 'object') return;
                this.live.vemActive = decodeVemActive(v.statusAdjustVEMVehicle);
                this.live.vemEvent = mapEnum(v.infoVemModeEvent, VEM_EVENT, VEM_EVENT_BY_NAME);
                if (typeof v.displayTargetSOCBatterysave === 'number' && v.displayTargetSOCBatterysave <= 100) {
                    this.live.targetSocDisplay = v.displayTargetSOCBatterysave;
                }
                if (typeof v.setupDestinationSOCBatterysave === 'number' && v.setupDestinationSOCBatterysave <= 100) {
                    this.live.targetSocSetup = v.setupDestinationSOCBatterysave;
                }
                this.live.recupLevel = v.statusSetupRecuperationLevel !== undefined ? String(v.statusSetupRecuperationLevel) : null;
                this._onSignal('Eff2', 'statusSocHoldConfiguration', v, {
                    vemActive: this.live.vemActive,
                    vemEvent: this.live.vemEvent,
                    targetSocDisplay: this.live.targetSocDisplay,
                    targetSocSetup: this.live.targetSocSetup,
                });
            },
            statusAnticipatedModeHybrid: (v) => {
                if (!v || typeof v !== 'object') return;
                this.live.foresightSit = mapEnum(v.displayHybridForesightSituation, FORESIGHT_SIT, FORESIGHT_BY_NAME);
                this.live.foresightDist = v.displayHybridForesightDistance !== undefined ? String(v.displayHybridForesightDistance) : null;
                this._onSignal('Eff2', 'statusAnticipatedModeHybrid', v, {
                    sit: this.live.foresightSit,
                    dist: this.live.foresightDist,
                });
            },
            statusOperatingModeHybrid: (v) => {
                if (!v || typeof v !== 'object') return;
                if (typeof v.displayOperatingModeDriveHybrid === 'number') {
                    this.live.opModeHybrid = v.displayOperatingModeDriveHybrid;
                }
                this.live.recupReasonSra = v.displayRecuperationReasonSRA !== undefined ? String(v.displayRecuperationReasonSRA) : null;
                this._onSignal('Eff2', 'statusOperatingModeHybrid', v, {
                    opMode: this.live.opModeHybrid,
                    sra: this.live.recupReasonSra,
                });
            },
            statusPowerRelativHybrid: (v) => {
                if (!v || typeof v !== 'object') return;
                const d = v.displayActualValuePowerRelativeDrivingElectric;
                const r = v.displayActualValuePowerRelativeRecuperation;
                if (typeof d === 'number' && d < 254) this.live.evDrivePct = d;
                if (typeof r === 'number' && r < 254) this.live.evRecupPct = r;
                this._onSignal('Eff2', 'statusPowerRelativHybrid', v, { d: d, r: r }, { highRate: true });
            },
            statusChargeOfBatteryHybrid: (v) => {
                const raw = v && typeof v === 'object' ? v.displayChargingConditionHighVoltageStorage : v;
                if (typeof raw === 'number' && isFinite(raw) && raw <= 100) {
                    this.live.socPct = raw;
                }
                this._onSignal('Eff2', 'statusChargeOfBatteryHybrid', v, { socPct: this.live.socPct });
            },
            statusBatteryTemperature: (v) => {
                const raw = v && typeof v === 'object' ? v.displayBatteryTemperature : v;
                if (typeof raw === 'number' && raw < 254) this.live.battTempC = raw - 48;
                this._onSignal('Eff2', 'statusBatteryTemperature', v, { battTempC: this.live.battTempC });
            },
        });

        // 2. Efficiencytainment (0xb506) - ICE Start Reason, Sailing/Coasting, Backchannel
        watch('de.bmw.infotainment.drivingexcitement.Efficiencytainment', '1', {
            statusReasonPowerUpCombustionEngine: (v) => {
                const raw = v && typeof v === 'object' ? v.displaySwitchOffPreventionCombustionEngineReason : v;
                this.live.iceReason = mapEnum(raw, ICE_REASONS, ICE_REASON_BY_NAME);
                this._onSignal('Eff', 'statusReasonPowerUpCombustionEngine', v, { iceReason: this.live.iceReason });
            },
            statusPowerTrainSailing: (v) => {
                const raw = v && typeof v === 'object' ? v.statusSailingDrive : v;
                this.live.sailing = mapEnum(raw, SAILING_STATES, SAILING_BY_NAME);
                this._onSignal('Eff', 'statusPowerTrainSailing', v, { sailing: this.live.sailing });
            },
            backchannelDrivingmodeDxp: (v) => {
                if (!v || typeof v !== 'object') return;
                this.live.availToggleBattCtrl = v.availabilityToggleBatteryControl !== undefined ? String(v.availabilityToggleBatteryControl) : null;
                this.live.availBattCtrlReason = v.statusAvailabilityBatteryControlDrivingExperience !== undefined ? String(v.statusAvailabilityBatteryControlDrivingExperience) : null;
                this.live.availToggleElectric = v.availabilityToggleElectricMode !== undefined ? String(v.availabilityToggleElectricMode) : null;
                this._onSignal('Eff', 'backchannelDrivingmodeDxp', v, {
                    availToggleBattCtrl: this.live.availToggleBattCtrl,
                    availBattCtrlReason: this.live.availBattCtrlReason,
                });
            },
            statusDisplayHybridBenefit: (v) => {
                const raw = v && typeof v === 'object' ? v.DisplayEffectivenessHybrid : v;
                if (typeof raw === 'number' && raw < 254) this.live.hybridBenefit = raw;
                this._onSignal('Eff', 'statusDisplayHybridBenefit', v, { hybridBenefit: this.live.hybridBenefit });
            },
            statusECOState1: (v) => {
                const raw = v && typeof v === 'object' ? v.displayECOStatusFunctionMSA : v;
                this.live.ecoMsaState = raw !== undefined ? String(raw) : null;
                this._onSignal('Eff', 'statusECOState1', v, { ecoMsaState: this.live.ecoMsaState });
            },
        });

        // 3. FES (0xb50d) - Drive Mode, Drive Strategy, EV Prevention
        watch('de.bmw.infotainment.drivingexcitement.FES', '1', {
            statusFESVehicleDynamicSwitchHMI: (v) => {
                if (!v || typeof v !== 'object') return;
                this.live.driveMode = decodeDriveMode(v.actualValueModeDrivingExperience);
                this.live.driveModeAvail = v.displayAvailibilityModeDrivingExperience !== undefined ? String(v.displayAvailibilityModeDrivingExperience) : null;
                this._onSignal('FES', 'statusFESVehicleDynamicSwitchHMI', v, { driveMode: this.live.driveMode });
            },
            statusFESDriveStrategy: (v) => {
                if (!v || typeof v !== 'object') return;
                this.live.batteryControl = decodeBattCtrlState(v.statusSetupBatteryControl);
                this.live.setupElectricMode = v.statusSetupElectricMode !== undefined ? String(v.statusSetupElectricMode) : null;
                this.live.prefElectricDrive = decodePrefEv(v.statusSetupPreferenceElectricDriveDriving);
                this.live.adjustSailing = v.statusAdjustSailingVehicle !== undefined ? String(v.statusAdjustSailingVehicle) : null;
                this.live.ecoSailing = v.statusECOFunctionSailingDrivingExperience !== undefined ? String(v.statusECOFunctionSailingDrivingExperience) : null;
                this.live.intelRangeCfg = v.driverConfigurationIntelligentRangeDisplay;
                this._onSignal('FES', 'statusFESDriveStrategy', v, {
                    batteryControl: this.live.batteryControl,
                    prefElectricDrive: this.live.prefElectricDrive,
                    adjustSailing: this.live.adjustSailing,
                    ecoSailing: this.live.ecoSailing,
                });
            },
            statusEDriveEVSystemState: (v) => {
                if (!v || typeof v !== 'object') return;
                this.live.evPrevent2 = mapEnum(v.actualValueReasonPreventionElectricVehicle2, EV_PREVENT, null);
                this.live.evHeadUnitMode = v.displayDriveElectricVehicleHeadUnit !== undefined ? String(v.displayDriveElectricVehicleHeadUnit) : null;
                this._onSignal('FES', 'statusEDriveEVSystemState', v, {
                    evPrevent2: this.live.evPrevent2,
                    evHeadUnitMode: this.live.evHeadUnitMode,
                });
            },
            statusElectricVehicleDriveSystemState: (v) => {
                if (!v || typeof v !== 'object') return;
                this.live.evPrevent1 = mapEnum(v.actualValueReasonPreventionElectricVehicle, EV_PREVENT, null);
                this.live.actualDriveEv = v.actualValueDriveElectricVehicle;
                this._onSignal('FES', 'statusElectricVehicleDriveSystemState', v, {
                    evPrevent1: this.live.evPrevent1,
                    actualDriveEv: this.live.actualDriveEv,
                });
            },
        });

        // 4. Powertrain (0x9530) & Range (0x9500)
        watch('de.bmw.powertrain.Powertrain', '1', {
            StatusCombustionEngine: (v) => {
                if (!v || typeof v !== 'object') return;
                this.live.iceState = decodeEngineState(v.statusCombustionEngineDrive);
                this.live.evModeFlag = decodeBoolFlag(v.dummyStatusElectricMode, 'ELECTRICMODE_ACTIVE', 'ELECTRICMODE_NOT_ACTIVE');
                this.live.eMotorReady = decodeBoolFlag(v.statusMotorDrive, 'E_MINUS_MASCHINE_IST_ELEKTRISCH_FAHRBEREIT_ODER_BEREITS_AKTIV', 'KEIN_E_MINUS_MASCHINE_VERFUEGBAR');
                this.live.gearboxConfig = v.powertrainConfigurationGearbox !== undefined ? String(v.powertrainConfigurationGearbox) : null;
                this._onSignal('Powertrain', 'StatusCombustionEngine', v, {
                    iceState: this.live.iceState,
                    evModeFlag: this.live.evModeFlag,
                    gearboxConfig: this.live.gearboxConfig,
                });
            },
        });

        watch('de.bmw.powertrain.Range', '1', {
            dataRangeCalculation: (v) => {
                const raw = v && typeof v === 'object' ? v.currentRouteIntelligentRangeDisplay : v;
                const active = decodeBoolFlag(raw, 'FUER_AKTUELLE_ROUTE_AKTIV', 'FUER_AKTUELLE_ROUTE_NICHT_AKTIV');
                this.live.intelligentRangeActive = active === true ? 'ACTIVE' : (active === false ? 'INACTIVE' : String(raw));
                this._onSignal('Range', 'dataRangeCalculation', v, { intelligentRangeActive: this.live.intelligentRangeActive });
            },
            dataRangeDisplay: (v) => {
                if (!v || typeof v !== 'object') return;
                if (typeof v.dataRangeDisplayElectric === 'number' && v.dataRangeDisplayElectric < 4095) {
                    this.live.rangeElectric = v.dataRangeDisplayElectric;
                }
                if (typeof v.dataRangeDisplayTotal === 'number' && v.dataRangeDisplayTotal < 4095) {
                    this.live.rangeTotal = v.dataRangeDisplayTotal;
                }
                this.live.rangeUnit = v.unitRangeDisplay !== undefined ? String(v.unitRangeDisplay) : null;
                this._onSignal('Range', 'dataRangeDisplay', v, {
                    rangeElectric: this.live.rangeElectric,
                    rangeTotal: this.live.rangeTotal,
                    rangeUnit: this.live.rangeUnit,
                });
            },
        });

        // 5. Vehicle (0xb510), Vehicle2 (0xb519), CDS, KombiIF (0xb51b)
        watch('de.bmw.infotainment.vehicle.Vehicle', '1', {
            statusTripInformationElectricHybrid: (v) => {
                if (!v || typeof v !== 'object') return;
                this.live.tripForecastPower = v.forecastAverageHighVoltageStoragePower;
                this.live.tripAvailHvNet = v.availableHighVoltageStorageNet;
                this.live.tripMux = v.multiplexerForecastRideInformation !== undefined ? String(v.multiplexerForecastRideInformation) : null;
                this._onSignal('Vehicle', 'statusTripInformationElectricHybrid', v, {
                    tripForecastPower: this.live.tripForecastPower,
                    tripAvailHvNet: this.live.tripAvailHvNet,
                    tripMux: this.live.tripMux,
                });
            },
            intelligentRangeCalculation: (v) => {
                if (!v || typeof v !== 'object') return;
                this.live.netAvailHv = v.netAvailabilityHighVoltageStorage;
                this._onSignal('Vehicle', 'intelligentRangeCalculation', v, { netAvailHv: this.live.netAvailHv });
            },
            statusDriveVehicle: (v) => {
                if (!v || typeof v !== 'object') return;
                this.live.statusDriveVehicle = v.statusDriveVehicle;
                this._onSignal('Vehicle', 'statusDriveVehicle', v, { statusDriveVehicle: this.live.statusDriveVehicle });
            },
            statusMotorStartAuto: (v) => {
                if (!v || typeof v !== 'object') return;
                this.live.msaCondition = v.statusConditionMSA !== undefined ? String(v.statusConditionMSA) : null;
                this._onSignal('Vehicle', 'statusMotorStartAuto', v, { msaCondition: this.live.msaCondition });
            },
        });

        watch('de.bmw.infotainment.vehicle.Vehicle2', '1', {
            statusCarSpeed2: (v) => {
                const raw = v && typeof v === 'object' ? v.speedVehicleCentreOfGravity : null;
                if (typeof raw === 'number' && raw < 65535) {
                    this.live.speedKmh = raw * 0.015625;
                    this._onSignal('Vehicle2', 'statusCarSpeed2', v, { speedKmh: this.live.speedKmh }, { highRate: true });
                }
            },
            highVoltageStorageInfoToExternal: (v) => {
                if (!v || typeof v !== 'object') return;
                this.live.hvEnergyDyn = v.energyDischargeHighVoltageStoragePresentDynamic;
                this.live.hvEnergyMax = v.energyDischargeHighVoltageStorageMaximalDynamic;
                this._onSignal('Vehicle2', 'highVoltageStorageInfoToExternal', v, {
                    hvEnergyDyn: this.live.hvEnergyDyn,
                    hvEnergyMax: this.live.hvEnergyMax,
                });
            },
        });

        watch('de.bmw.infotainment.vehicle.CDS', '1', {
            statusEngineSpeed2: (v) => {
                const raw = v && typeof v === 'object' ? v.actualValueRPMEngineCrankshaft : null;
                if (typeof raw === 'number' && raw < 65535) {
                    const rpm = raw * 0.25;
                    this.live.rpm = rpm < ICE_RPM_THRESHOLD ? 0 : rpm;
                    this._onSignal('CDS', 'statusEngineSpeed2', v, { rpm: this.live.rpm }, { highRate: true });
                }
            },
            statusEngineStatus: (v) => {
                const raw = v && typeof v === 'object' ? v.statusEngineRunDrive : v;
                this.live.cdsEngineState = decodeEngineState(raw);
                this._onSignal('CDS', 'statusEngineStatus', v, { cdsEngineState: this.live.cdsEngineState });
            },
        });

        watch('de.bmw.infotainment.KombiIF', '1', {
            displayRangeElectricVehicle: (v) => {
                if (!v || typeof v !== 'object') return;
                if (typeof v.displayRangeElectricVehicle === 'number' && v.displayRangeElectricVehicle < 4095) {
                    this.live.kombiEvRange = v.displayRangeElectricVehicle;
                }
                this._onSignal('KombiIF', 'displayRangeElectricVehicle', v, { kombiEvRange: this.live.kombiEvRange });
            },
            statusDisplayElectricalPowerDistribution: (v) => {
                if (!v || typeof v !== 'object') return;
                this.live.evPowerDriveDist = v.displayRepartitionDriveElectricPower;
                this.live.evPowerAcDist = v.displayRepartitionAirConditioningElectricPower;
                this._onSignal('KombiIF', 'statusDisplayElectricalPowerDistribution', v, {
                    drive: this.live.evPowerDriveDist,
                    ac: this.live.evPowerAcDist,
                });
            },
        });

        // 6. NavigationCAN (0xb524), ADAS NavGraph resync (0xb51d), Guidance, CarPlay
        watch('de.bmw.infotainment.navigation.NavigationCAN', '1', {
            calculationDataNavigation: (v) => {
                if (!v || typeof v !== 'object') return;
                this.live.navCanDistRaw = v.statusDistanceDestinationNavigation;
                this.live.navCanUnit = v.statusDistanceDestinationNavigationUnitOfMeasurement !== undefined
                    ? String(v.statusDistanceDestinationNavigationUnitOfMeasurement) : null;
                this._onSignal('NavCAN', 'calculationDataNavigation', v, {
                    distRaw: this.live.navCanDistRaw,
                    unit: this.live.navCanUnit,
                });
            },
        });

        watch('de.bmw.infotainment.navigation.ADAS', '1', {
            resynchronisationNavigationGraph: (v) => {
                if (!v || typeof v !== 'object') return;
                const sender = mapEnum(v.identificationSenderResynchronizationNavigation, RESYNC_SENDERS, null);
                this.live.navResyncCount = (this.live.navResyncCount || 0) + 1;
                this.live.navResyncLastSender = sender;
                this.live.navResyncLastErr = v.statusErrorNumberReceiverNavigation;
                this._onSignal('ADAS', 'resynchronisationNavigationGraph', v, {
                    sender: sender,
                    err: v.statusErrorNumberReceiverNavigation,
                    cnt: v.statusCounterNavGraphSync,
                });
            },
        });

        watch('de.bmw.infotainment.navigation.guiding.Guidance', 'Main_Instance', {
            guidanceState: (v) => {
                this.live.guidanceState = mapEnum(v, GUIDANCE_STATES, null);
                this._onSignal('Guidance', 'guidanceState', v, { guidanceState: this.live.guidanceState });
            },
            guidingProvider: (v) => {
                this.live.guidingProvider = mapEnum(v, GUIDING_PROVIDERS, null);
                this._onSignal('Guidance', 'guidingProvider', v, { guidingProvider: this.live.guidingProvider });
            },
            finalDestinationInfo: (v) => {
                const m = extractDestMeters(v);
                this.live.destMeters = m;
                this.live.destTravelSec = v && typeof v.travelTime === 'number' ? v.travelTime : null;
                this._onSignal('Guidance', 'finalDestinationInfo', {
                    destMeters: m,
                    travelTime: this.live.destTravelSec,
                }, { destMeters: m, travelTime: this.live.destTravelSec });
            },
            currentRoad: (v) => {
                this.live.currentRoad = extractRoadText(v);
                this._onSignal('Guidance', 'currentRoad', this.live.currentRoad, { currentRoad: this.live.currentRoad });
            },
        });

        watch('de.bmw.infotainment.a4a.carplay.CarPlayManager', 'CarPlayManagerInst1', {
            projectedGuidanceActive: (v) => {
                this.live.carPlayGuidance = Boolean(v);
                this._onSignal('CarPlay', 'projectedGuidanceActive', v, { carPlayGuidance: this.live.carPlayGuidance });
            },
        });

        // 7. Broadcast-only interfaces: ConnectedForesight (EDriveZones) & ADASNG CCP
        watchBroadcasts('de.bmw.infotainment.navigation.foresight.connected.ConnectedForesight', '1', {
            EDriveZones: (v) => {
                if (!v || typeof v !== 'object') return;
                this.live.eZoneEvents = (this.live.eZoneEvents || 0) + 1;
                this.live.eZone1Dist = v.eDriveZoneEventnr1Distance;
                this.live.eZone1Prob = v.eDriveZoneEventnr1OccurProbability;
                this.live.eZone1Cat = v.eDriveZoneEventnr1IndividualProperty2CategoryeDriveZone;
                this.live.eZone1Energy = v.eDriveZoneEventnr1IndividualProperty3EnergyDemandeDriveZone;
                this._onSignal('ConnectedForesight', 'EDriveZones', {
                    nr1: v.eDriveZoneEventnr1,
                    dist1: v.eDriveZoneEventnr1Distance,
                    len1: v.eDriveZoneEventnr1Length,
                    prob1: v.eDriveZoneEventnr1OccurProbability,
                    cat1: v.eDriveZoneEventnr1IndividualProperty2CategoryeDriveZone,
                    energy1: v.eDriveZoneEventnr1IndividualProperty3EnergyDemandeDriveZone,
                    hb: v.eDriveZoneHeartbeat,
                }, { eZone1Dist: this.live.eZone1Dist, eZone1Prob: this.live.eZone1Prob });
            },
        });

        watchBroadcasts('de.bmw.infotainment.navigation.externalize.adasng.CCP', '1', {
            roadClass: (v) => {
                if (!v || typeof v !== 'object') return;
                this.live.roadClassFunc = v.functional;
                this.live.roadClassAdmin = v.administrative;
                this._onSignal('CCP', 'roadClass', v, { func: v.functional, admin: v.administrative });
            },
            urbanFlag: (v) => {
                this.live.urbanFlag = v && typeof v === 'object' ? Boolean(v.isUrban) : Boolean(v);
                this._onSignal('CCP', 'urbanFlag', v, { urbanFlag: this.live.urbanFlag });
            },
            builtupAreaFlag: (v) => {
                this.live.builtupFlag = v && typeof v === 'object' ? Boolean(v.isBuiltupArea) : Boolean(v);
                this._onSignal('CCP', 'builtupAreaFlag', v, { builtupFlag: this.live.builtupFlag });
            },
            effectiveSpeedLimit: (v) => {
                this.live.speedLimit = v && typeof v === 'object' ? v.speedLimit : v;
                this._onSignal('CCP', 'effectiveSpeedLimit', v, { speedLimit: this.live.speedLimit });
            },
            rampFlag: (v) => {
                this.live.rampFlag = v && typeof v === 'object' ? Boolean(v.isRamp) : Boolean(v);
                this._onSignal('CCP', 'rampFlag', v, { rampFlag: this.live.rampFlag });
            },
        });

        // 8. VehicleCondition - flush & stop capture cleanly on sleep/park
        watch('de.bmw.infrastructure.VehicleCondition', '1', {
            VehicleCondition: (v) => {
                const raw = v && typeof v === 'object' ? v.statusConditionVehicle : v;
                this.live.vehicleCondition = raw;
                const n = typeof raw === 'number' ? raw : ({ PARKEN_BN_NIO: 1, PARKEN_BN_IO: 2, STANDFUNKTIONEN_KUNDE_NICHT_IM_FZG: 3, WOHNEN: 5, FAHREN: 10 })[String(raw)];
                if (n !== undefined && n <= 3) {
                    this.onSleep(raw);
                }
            },
        });

        // 1 Hz periodic tick logger (keeps timeline continuous even when signals are quiet)
        this._tickTimer = setInterval(() => {
            const now = this.now();
            this.demoActive = this.wantDemo(now);
            if (this.demoActive) this._checkIceTransition(now);
            if (this.recorder && this.recorder.active) {
                this.recorder.recordTick(this.snapshot(now), now);
            }
        }, 1000);
        if (this._tickTimer && typeof this._tickTimer.unref === 'function') this._tickTimer.unref();
    }

    _demoSample(nowMs) {
        const sec = ((nowMs - this._demoT0) / 1000) % 60;
        const highwayVem = sec >= 25;
        const speedKmh = highwayVem ? (92 + 6 * Math.sin(sec / 4)) : (84 + 6 * Math.sin(sec / 4));
        const iceOn = highwayVem && speedKmh >= 88;
        return {
            demo: true,
            speedKmh: Math.round(speedKmh * 10) / 10,
            speedMph: Math.round(speedKmh * KMH_TO_MPH * 10) / 10,
            rpm: iceOn ? 1480 : 0,
            iceOn: iceOn,
            iceState: iceOn ? 'RUNNING' : 'OFF',
            evModeFlag: !iceOn,
            eMotorReady: true,
            driveMode: 'PHEV_HYBRID_ECO',
            sailing: iceOn ? 'READY' : 'COASTING',
            batteryControl: 'OFF',
            prefElectricDrive: 'UNAVAIL',
            adjustSailing: 'SEGELN_ERLAUBT',
            vemActive: 'ON',
            vemEvent: 'NO_ACTION',
            foresightSit: highwayVem ? 'PRE_DEST' : 'NONE',
            foresightDist: highwayVem ? '_6_BALKEN' : '_0_BALKEN',
            opModeHybrid: highwayVem ? 4 : 1,
            iceReason: iceOn ? 'SYSTEM_REQ' : 'NONE',
            evPrevent1: 'NONE',
            evPrevent2: 'NONE',
            socPct: 62,
            targetSocDisplay: 30,
            rangeElectric: 18,
            rangeTotal: 310,
            intelligentRangeActive: highwayVem ? 'ACTIVE' : 'INACTIVE',
            guidanceState: highwayVem ? 'ACTIVE' : 'INACTIVE',
            guidingProvider: highwayVem ? 'BMW' : 'CARPLAY',
            carPlayGuidance: !highwayVem,
            destMeters: highwayVem ? 78500 : null,
            currentRoad: highwayVem ? 'I-280 S' : 'US-101 S',
            roadClassFunc: 0,
            urbanFlag: false,
            speedLimit: 105,
            navResyncCount: 0,
            navResyncLastSender: null,
            eZoneEvents: 0,
            eZone1Dist: null,
            tripForecastPower: highwayVem ? 18 : null,
            evDrivePct: iceOn ? 12 : 34,
            evRecupPct: 0,
        };
    }

    snapshot(nowMs) {
        const now = typeof nowMs === 'number' ? nowMs : this.now();
        if (this.wantDemo(now)) {
            this.demoActive = true;
            return this._demoSample(now);
        }
        this.demoActive = false;
        const l = this.live;
        const speedKmh = typeof l.speedKmh === 'number' ? Math.round(l.speedKmh * 10) / 10 : null;
        const speedMph = speedKmh !== null ? Math.round(speedKmh * KMH_TO_MPH * 10) / 10 : null;
        const iceOn = this._computeIceOn(l);
        return {
            demo: false,
            speedKmh: speedKmh,
            speedMph: speedMph,
            rpm: typeof l.rpm === 'number' ? Math.round(l.rpm) : null,
            iceOn: iceOn,
            iceState: l.iceState || l.cdsEngineState || null,
            evModeFlag: l.evModeFlag !== undefined ? l.evModeFlag : null,
            eMotorReady: l.eMotorReady !== undefined ? l.eMotorReady : null,
            driveMode: l.driveMode || null,
            sailing: l.sailing || null,
            batteryControl: l.batteryControl || null,
            prefElectricDrive: l.prefElectricDrive || null,
            adjustSailing: l.adjustSailing || null,
            availToggleBattCtrl: l.availToggleBattCtrl || null,
            vemActive: l.vemActive || null,
            vemEvent: l.vemEvent || null,
            foresightSit: l.foresightSit || null,
            foresightDist: l.foresightDist || null,
            opModeHybrid: l.opModeHybrid !== undefined ? l.opModeHybrid : null,
            iceReason: l.iceReason || null,
            evPrevent1: l.evPrevent1 || null,
            evPrevent2: l.evPrevent2 || null,
            msaCondition: l.msaCondition || null,
            socPct: l.socPct !== undefined ? l.socPct : null,
            targetSocDisplay: l.targetSocDisplay !== undefined ? l.targetSocDisplay : null,
            rangeElectric: l.rangeElectric !== undefined ? l.rangeElectric : (l.kombiEvRange !== undefined ? l.kombiEvRange : null),
            rangeTotal: l.rangeTotal !== undefined ? l.rangeTotal : null,
            intelligentRangeActive: l.intelligentRangeActive || null,
            guidanceState: l.guidanceState || null,
            guidingProvider: l.guidingProvider || null,
            carPlayGuidance: l.carPlayGuidance !== undefined ? l.carPlayGuidance : null,
            destMeters: l.destMeters !== undefined ? l.destMeters : null,
            navCanDistRaw: l.navCanDistRaw !== undefined ? l.navCanDistRaw : null,
            currentRoad: l.currentRoad || null,
            roadClassFunc: l.roadClassFunc !== undefined ? l.roadClassFunc : null,
            urbanFlag: l.urbanFlag !== undefined ? l.urbanFlag : null,
            speedLimit: l.speedLimit !== undefined ? l.speedLimit : null,
            navResyncCount: l.navResyncCount || 0,
            navResyncLastSender: l.navResyncLastSender || null,
            eZoneEvents: l.eZoneEvents || 0,
            eZone1Dist: l.eZone1Dist !== undefined ? l.eZone1Dist : null,
            tripForecastPower: l.tripForecastPower !== undefined ? l.tripForecastPower : null,
            evDrivePct: l.evDrivePct !== undefined ? l.evDrivePct : null,
            evRecupPct: l.evRecupPct !== undefined ? l.evRecupPct : null,
        };
    }

    health() {
        const keys = Object.keys(this.proxyStatus);
        let avail = 0;
        let errs = 0;
        for (let i = 0; i < keys.length; i++) {
            const st = this.proxyStatus[keys[i]];
            if (st.available) avail += 1;
            if (st.error) errs += 1;
        }
        return { total: keys.length, available: avail, errors: errs };
    }

    stop() {
        if (this._tickTimer) { clearInterval(this._tickTimer); this._tickTimer = null; }
        for (let i = 0; i < this.subs.length; i++) {
            try { if (this.subs[i] && this.subs[i].shutdown) this.subs[i].shutdown(); } catch (e) { /* ignore */ }
        }
    }
}

module.exports = {
    CaptureHub,
    decodeDriveMode,
    decodeEngineState,
    decodeVemActive,
    decodeBattCtrlState,
    decodePrefEv,
    mapEnum,
    ICE_REASONS,
    ICE_REASON_BY_NAME,
    SAILING_STATES,
    SAILING_BY_NAME,
    FORESIGHT_SIT,
    FORESIGHT_BY_NAME,
    VEM_EVENT,
    VEM_EVENT_BY_NAME,
};
