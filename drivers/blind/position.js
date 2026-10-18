'use strict';

// Dead-reckoned position for a motor that reports nothing back.
//
// There is no encoder and no feedback channel, so the only thing Homey can do is
// integrate: note when a motor started, which way it went, and how long its full
// travel takes, then read the clock. Everything here is that integral, plus an
// honest account of how wrong it might be by now.
//
// Positions use Homey's own units for `windowcoverings_set`: 0 is closed (fully
// down), 1 is open (fully up). The `invert_position` setting is applied at the
// capability boundary in device.js — this module only ever speaks in physical
// up and down, where there is nothing to invert.
//
// Nothing here touches a radio or a timer. It says what to drive and for how
// long; device.js does the driving.

const UP = 1;
const DOWN = -1;
const IDLE = 0;

// A move shorter than this is mostly the motor's start and stop ramp rather than
// travel, so acting on it adds more error to the estimate than it removes.
const MIN_MOVE_MS = 700;

// How far the estimate is assumed to drift over a move, as a fraction of the
// distance travelled. Covers a mis-set travel time, soft-start ramps, and a
// motor that runs slower under load than it did on the day it was timed.
const DRIFT_RATE = 0.05;

// What one stop costs the estimate, as a fraction of full travel. Our own stop
// is much the worse of the two: tx() resolves once Homey has queued the frame,
// not once it has gone out, so the airtime before the motor hears it cannot be
// measured from here. A stop we hear from the handset reaches us and the motor
// at the same moment, so almost all of that latency cancels.
const STOP_JITTER = { tx: 0.02, rx: 0.005 };

// Past this, an intermediate position is a guess rather than an estimate, and
// the move is worth anchoring against an end stop first. 0.15 of a 30s travel is
// about 4.5s of doubt — roughly a hand's width on a real blind.
const MAX_UNCERTAINTY = 0.15;

// Run limit runs this much past the worst case the estimate allows for, so a
// travel time set slightly short still ends up against the stop rather than
// just short of it.
const ARRIVAL_MARGIN = 0.1;

const clamp = value => Math.min(1, Math.max(0, value));

class Position {
    // `upTime` and `downTime` are full-travel times in milliseconds, and differ
    // on most tubular motors: gravity helps one direction and fights the other.
    // A single figure for both bakes a fixed error into every partial move.
    //
    // `uncertainty` is how far the position may be out, as a fraction of full
    // travel. It starts at 1 — completely unknown — because a blind Homey has
    // never driven could be anywhere.
    constructor({
        upTime, downTime, position = 1, uncertainty = 1, now = Date.now,
    }) {
        this.retime(upTime, downTime);
        this.origin = clamp(position);
        this.uncertainty = clamp(uncertainty);
        this.now = now;

        this.direction = IDLE;
        this.startedAt = 0;
        // The origin the limit runs are timed against; see worstAt().
        this.worstOrigin = this.origin;
    }

    retime(upTime, downTime) {
        this.upTime = upTime;
        this.downTime = downTime;
    }

    travelTime(direction) {
        return direction === UP ? this.upTime : this.downTime;
    }

    get moving() {
        return this.direction !== IDLE;
    }

    // Signed fraction of full travel covered since the current leg started.
    travelled(now) {
        if (this.direction === IDLE) return 0;
        return this.direction * (now - this.startedAt) / this.travelTime(this.direction);
    }

    // Where the estimate says the blind is.
    at(now = this.now()) {
        return clamp(this.origin + this.travelled(now));
    }

    // Where it would be if the estimate had been wrong by the full uncertainty,
    // in whichever direction leaves it furthest from where it is heading. Limit
    // runs are timed against this rather than against at(), because a run that
    // ends when the optimistic estimate reaches the top will stop a blind that
    // started lower than we thought while it is still moving — and record it as
    // exactly open when it is not.
    worstAt(now = this.now()) {
        return clamp(this.worstOrigin + this.travelled(now));
    }

    // The pessimistic starting point for a run in `direction`.
    worstStart(direction, now = this.now()) {
        return clamp(this.at(now) - direction * this.uncertainty);
    }

    // Whether even the pessimistic estimate has the blind against the end stop it
    // is heading for. Past that moment its position is a fact about the blind
    // rather than about our clock, however far off the clock was.
    arrived(now = this.now()) {
        if (this.direction === IDLE) return false;
        return this.worstAt(now) === (this.direction === UP ? 1 : 0);
    }

    // How long an open-ended run in `direction` from `from` needs before the
    // blind is certainly against the end stop.
    limitDuration(direction, from) {
        const distance = direction === UP ? 1 - from : from;
        return Math.round(distance * this.travelTime(direction) * (1 + ARRIVAL_MARGIN));
    }

    // Starts a leg. Returns the open-ended run time, which the caller needs when
    // the leg has no scheduled stop of its own.
    run(direction, now = this.now()) {
        // A leg that is redirected rather than stopped still travelled, and that
        // travel still cost the estimate something.
        if (this.moving) this.halt('tx', now);

        this.worstOrigin = this.worstStart(direction, now);
        this.direction = direction;
        this.startedAt = now;
        return this.limitDuration(direction, this.worstOrigin);
    }

    // Ends a leg, either because we sent STOP or because we heard one from the
    // handset — `source` says which, and it changes what the stop costs. Also
    // called when a limit run is over, where arriving is what matters and the
    // source does not.
    halt(source = 'tx', now = this.now()) {
        if (!this.moving) return this.origin;

        const arrived = this.arrived(now);
        const travelled = Math.abs(this.travelled(now));

        this.origin = this.at(now);
        this.direction = IDLE;
        this.worstOrigin = this.origin;

        if (arrived) {
            // Against a hard stop. The motor's own limit switch, not our clock,
            // is now the frame of reference — which is the whole of the drift
            // repair, and why a run to an end never gets a timed stop.
            this.uncertainty = 0;
        } else {
            this.uncertainty = clamp(this.uncertainty
                + travelled * DRIFT_RATE
                + (STOP_JITTER[source] ?? STOP_JITTER.tx));
        }

        return this.origin;
    }

    // Everything known for certain, e.g. straight after a calibration run.
    reset(position, now = this.now()) {
        this.direction = IDLE;
        this.startedAt = now;
        this.origin = clamp(position);
        this.worstOrigin = this.origin;
        this.uncertainty = 0;
        return this.origin;
    }

    // How to get to `target`, as legs for device.js to drive in order. A leg is
    // either `limit` — run until the motor's own end stop catches it, which is
    // both the move and a recalibration — or a timed run that we stop ourselves.
    // `duration` is milliseconds. An empty list means there is nothing worth
    // doing.
    plan(target, now = this.now()) {
        target = clamp(target);

        const limitLeg = direction => ({
            direction,
            limit: true,
            duration: this.limitDuration(direction, this.worstStart(direction, now)),
        });

        // An end position never needs timing at all: the motor has limit
        // switches, so letting it run into one is the accurate way to get there.
        if (target === 1) return [limitLeg(UP)];
        if (target === 0) return [limitLeg(DOWN)];

        const legs = [];
        let from = this.at(now);

        if (this.uncertainty > MAX_UNCERTAINTY) {
            // Too uncertain to time an intermediate position from here. Anchor
            // against an end stop first, then time the rest from a position that
            // is known exactly.
            //
            // Always the open end, even where the closed one would get there
            // sooner. Anchoring at the top bounds the move by the position that
            // was asked for: the overshoot goes up into the housing, where there
            // is nothing to hit. Via the bottom, a request for 40% would close
            // the blind completely first — the whole way across the opening on a
            // floor-to-ceiling blind that encloses an outdoor area, or right out
            // over the patio on an awning — and nothing here can tell that it
            // has closed onto a person, an animal or the furniture. Open is also
            // where a wind sensor sends an awning. The cost is travel time on a
            // low target, and only until the next run to an end makes the
            // estimate certain again.
            legs.push(limitLeg(UP));
            from = 1;
        }

        const delta = target - from;
        const direction = delta > 0 ? UP : DOWN;
        const duration = Math.round(Math.abs(delta) * this.travelTime(direction));

        // Below the deadband there is no move to make. When a recalibration leg
        // is already queued this drops only the second leg, which is right: the
        // target was as good as the end stop we are on our way to.
        if (duration >= MIN_MOVE_MS) legs.push({ direction, limit: false, duration });

        return legs;
    }
}

module.exports = {
    Position,
    UP,
    DOWN,
    IDLE,
    MIN_MOVE_MS,
    DRIFT_RATE,
    STOP_JITTER,
    MAX_UNCERTAINTY,
    ARRIVAL_MARGIN,
    clamp,
};
