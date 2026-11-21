#!/usr/bin/env node
'use strict';
/**
 * analyze-capture.js - Offline analyzer for Hybrid Capture JSONL sessions.
 *
 * Usage:
 *   node scripts/analyze-capture.js <path/to/capture.jsonl>
 */

const fs = require('fs');

function parseJsonl(text) {
    const lines = String(text || '').split(/\r?\n/);
    const records = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
            records.push(JSON.parse(line));
        } catch (e) { /* skip truncated tail line */ }
    }
    return records;
}

function addSet(map, key, val) {
    if (val === undefined || val === null || val === '') return;
    if (!map[key]) map[key] = Object.create(null);
    map[key][String(val)] = (map[key][String(val)] || 0) + 1;
}

function summarizeSet(obj) {
    if (!obj) return '--';
    return Object.keys(obj)
        .sort((a, b) => obj[b] - obj[a])
        .map((k) => k + '(' + obj[k] + ')')
        .join(', ');
}

function analyzeRecords(records) {
    const phases = Object.create(null);
    const iceStarts = [];
    const iceStops = [];
    const markers = [];
    const probes = [];
    let tFirst = null;
    let tLast = null;
    let sigEvents = 0;
    let ticks = 0;

    function phaseBucket(name) {
        const k = name || 'untagged';
        if (!phases[k]) {
            phases[k] = {
                ticks: 0,
                iceTicks: 0,
                sailTicks: 0,
                minIceCutInMph: null,
                maxSpeedMph: 0,
                sets: Object.create(null),
            };
        }
        return phases[k];
    }

    for (let i = 0; i < records.length; i++) {
        const r = records[i];
        if (typeof r.t === 'number') {
            if (tFirst === null || r.t < tFirst) tFirst = r.t;
            if (tLast === null || r.t > tLast) tLast = r.t;
        }
        if (r.type === 'sig') {
            sigEvents += 1;
        } else if (r.type === 'tick' && r.s) {
            ticks += 1;
            const b = phaseBucket(r.phase);
            b.ticks += 1;
            if (r.s.iceOn === true) b.iceTicks += 1;
            if (r.s.sailing === 'COASTING' || r.s.sailing === 'BRAKED_SAIL') b.sailTicks += 1;
            if (typeof r.s.speedMph === 'number' && r.s.speedMph > b.maxSpeedMph) b.maxSpeedMph = r.s.speedMph;
            addSet(b.sets, 'driveMode', r.s.driveMode);
            addSet(b.sets, 'vemActive', r.s.vemActive);
            addSet(b.sets, 'vemEvent', r.s.vemEvent);
            addSet(b.sets, 'opModeHybrid', r.s.opModeHybrid);
            addSet(b.sets, 'foresightSit', r.s.foresightSit);
            addSet(b.sets, 'iceReason', r.s.iceReason);
            addSet(b.sets, 'intelRange', r.s.intelligentRangeActive);
            addSet(b.sets, 'roadClass', r.s.roadClassFunc);
        } else if (r.type === 'ice_transition') {
            const b = phaseBucket(r.phase);
            const mph = r.s && typeof r.s.speedMph === 'number' ? r.s.speedMph : null;
            if (r.direction === 'start') {
                iceStarts.push(r);
                if (mph !== null && (b.minIceCutInMph === null || mph < b.minIceCutInMph)) {
                    b.minIceCutInMph = mph;
                }
            } else {
                iceStops.push(r);
            }
        } else if (r.type === 'marker') {
            markers.push(r);
        } else if (r.type === 'probe') {
            probes.push(r);
        }
    }

    return {
        totalRecords: records.length,
        durationSec: tFirst !== null && tLast !== null ? Math.round((tLast - tFirst) / 1000) : 0,
        sigEvents: sigEvents,
        ticks: ticks,
        phases: phases,
        iceStarts: iceStarts,
        iceStops: iceStops,
        markers: markers,
        probes: probes,
    };
}

function formatReport(res) {
    const out = [];
    out.push('=== Hybrid Capture Analysis ===');
    out.push('Records: ' + res.totalRecords + ' | Duration: ' + res.durationSec + 's | Signal changes: ' + res.sigEvents + ' | 1Hz ticks: ' + res.ticks);
    out.push('ICE starts: ' + res.iceStarts.length + ' | ICE stops: ' + res.iceStops.length + ' | Markers: ' + res.markers.length + ' | Probes: ' + res.probes.length);

    out.push('\n--- Phase Comparison ---');
    const pNames = Object.keys(res.phases);
    if (!pNames.length) {
        out.push('  (no 1Hz ticks recorded)');
    }
    for (let i = 0; i < pNames.length; i++) {
        const pn = pNames[i];
        const b = res.phases[pn];
        const icePct = b.ticks ? Math.round((b.iceTicks / b.ticks) * 100) : 0;
        const sailPct = b.ticks ? Math.round((b.sailTicks / b.ticks) * 100) : 0;
        out.push('[' + pn + '] ticks=' + b.ticks + 's | ICE=' + icePct + '% | Sail=' + sailPct + '% | maxSpd=' + b.maxSpeedMph.toFixed(1) + 'mph | lowestIceCutIn=' + (b.minIceCutInMph !== null ? b.minIceCutInMph.toFixed(1) + 'mph' : '--'));
        out.push('  driveMode : ' + summarizeSet(b.sets.driveMode));
        out.push('  vemActive : ' + summarizeSet(b.sets.vemActive) + ' | vemEvent: ' + summarizeSet(b.sets.vemEvent));
        out.push('  opModeHyb : ' + summarizeSet(b.sets.opModeHybrid) + ' | intelRange: ' + summarizeSet(b.sets.intelRange));
        out.push('  foresight : ' + summarizeSet(b.sets.foresightSit) + ' | roadClass: ' + summarizeSet(b.sets.roadClass));
        out.push('  iceReason : ' + summarizeSet(b.sets.iceReason));
    }

    if (res.iceStarts.length) {
        out.push('\n--- ICE Cut-In Events ---');
        for (let i = 0; i < res.iceStarts.length; i++) {
            const e = res.iceStarts[i];
            const s = e.s || {};
            out.push(
                '  dt=' + Math.round((e.dt || 0) / 1000) + 's [' + (e.phase || '?') + '] ' +
                (s.speedMph !== null && s.speedMph !== undefined ? s.speedMph.toFixed(1) + 'mph' : '?mph') +
                ' SoC=' + (s.socPct !== null && s.socPct !== undefined ? s.socPct + '%' : '?') +
                ' mode=' + (s.driveMode || '?') +
                ' sail=' + (s.sailing || '?') +
                ' vem=' + (s.vemActive || '?') +
                ' opMode=' + (s.opModeHybrid !== null && s.opModeHybrid !== undefined ? s.opModeHybrid : '?') +
                ' reason=' + (s.iceReason || '?') +
                ' fore=' + (s.foresightSit || '?') +
                ' intelRng=' + (s.intelligentRangeActive || '?') +
                ' FRC=' + (s.roadClassFunc !== null && s.roadClassFunc !== undefined ? s.roadClassFunc : '?')
            );
        }
    }

    if (res.markers.length) {
        out.push('\n--- User Markers ---');
        for (let i = 0; i < res.markers.length; i++) {
            const m = res.markers[i];
            const s = m.s || {};
            out.push(
                '  dt=' + Math.round((m.dt || 0) / 1000) + 's [' + (m.phase || '?') + '] ' + (m.label || 'mark') +
                ' spd=' + (s.speedMph !== null && s.speedMph !== undefined ? s.speedMph.toFixed(1) + 'mph' : '?') +
                ' ice=' + s.iceOn + ' mode=' + (s.driveMode || '?') + ' reason=' + (s.iceReason || '?') + ' opMode=' + s.opModeHybrid
            );
        }
    }

    if (res.probes.length) {
        out.push('\n--- Experimental Write Probes ---');
        for (let i = 0; i < res.probes.length; i++) {
            const p = res.probes[i];
            out.push('  dt=' + Math.round((p.dt || 0) / 1000) + 's ' + p.action + ' -> ' + p.result);
        }
    }

    return out.join('\n');
}

if (require.main === module) {
    const file = process.argv[2];
    if (!file) {
        console.error('Usage: node scripts/analyze-capture.js <capture.jsonl>');
        process.exit(1);
    }
    const text = fs.readFileSync(file, 'utf8');
    const res = analyzeRecords(parseJsonl(text));
    console.log(formatReport(res));
}

module.exports = { parseJsonl, analyzeRecords, formatReport };
