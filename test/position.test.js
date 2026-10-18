'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    Position, UP, DOWN, IDLE, MIN_MOVE_MS, MAX_UNCERTAINTY,
} = require('../drivers/blind/position');

// Up and down are deliberately different, because they are on a real motor, and
// a tracker that only ever gets equal times will not notice it is using the
// wrong one. Round numbers so the expected positions are readable.
const UP_TIME = 20000;
const DOWN_TIME = 30000;

// A clock the test drives, so nothing here waits on wall time.
function clock() {
    let t = 1000;
    return {
        now: () => t,
        advance(ms) {
            t += ms;
            return t;
        },
    };
}

// A blind whose position is known exactly, as it is straight after any run into
// an end stop. Most cases want this; the uncertain ones say so.
function known(position = 1, timings = {}) {
    const time = clock();
    const tracker = new Position({
        upTime: UP_TIME, downTime: DOWN_TIME, now: time.now, ...timings,
    });
    tracker.reset(position);
    return { tracker, time };
}

test('a fresh blind is completely unknown', () => {
    const tracker = new Position({ upTime: UP_TIME, downTime: DOWN_TIME });
    assert.equal(tracker.uncertainty, 1);
    assert.equal(tracker.direction, IDLE);
    assert.equal(tracker.moving, false);
});

test('position integrates at the travel time for the direction', () => {
    const { tracker, time } = known(1);

    tracker.run(DOWN);
    time.advance(15000);
    assert.equal(tracker.at(), 0.5, 'half of a 30s downward travel');

    tracker.halt('tx');
    tracker.run(UP);
    time.advance(5000);
    assert.equal(tracker.at(), 0.75, 'a quarter of a 20s upward travel');
});

test('position never leaves 0..1, however long the motor runs', () => {
    const { tracker, time } = known(1);

    tracker.run(DOWN);
    time.advance(DOWN_TIME * 3);
    assert.equal(tracker.at(), 0);

    tracker.halt('tx');
    tracker.run(UP);
    time.advance(UP_TIME * 3);
    assert.equal(tracker.at(), 1);
});

test('a stop mid-travel leaves the estimate less certain than it was', () => {
    const { tracker, time } = known(1);

    tracker.run(DOWN);
    time.advance(6000); // 0.2 of full travel
    tracker.halt('tx');

    assert.equal(tracker.at(), 0.8);
    // 0.2 travelled at 5%, plus the cost of one stop of ours.
    assert.equal(round(tracker.uncertainty), 0.03);
});

test('a stop heard from the handset costs less than one we sent', () => {
    // We hear the frame the motor hears, at the same moment, so the transmit
    // latency that makes our own stops uncertain largely cancels.
    const ours = known(1);
    ours.tracker.run(DOWN);
    ours.time.advance(6000);
    ours.tracker.halt('tx');

    const theirs = known(1);
    theirs.tracker.run(DOWN);
    theirs.time.advance(6000);
    theirs.tracker.halt('rx');

    assert.ok(theirs.tracker.uncertainty < ours.tracker.uncertainty);
    assert.equal(round(theirs.tracker.uncertainty), 0.015);
});

test('running into an end stop makes the position exact again', () => {
    const { tracker, time } = known(0.5);
    // Drift the estimate first, so the recalibration has something to repair.
    tracker.uncertainty = 0.4;

    const duration = tracker.run(UP);
    assert.equal(tracker.arrived(), false);

    time.advance(duration);
    assert.equal(tracker.arrived(), true);

    tracker.halt('tx');
    assert.equal(tracker.at(), 1);
    assert.equal(tracker.uncertainty, 0, 'the limit switch, not the clock, says where it is');
});

test('a limit run is timed against the worst the estimate allows for', () => {
    // The estimate says halfway; it could be anywhere in the bottom half. A run
    // timed from the estimate would call it open while it was still moving.
    const { tracker, time } = known(0.5);
    tracker.uncertainty = 0.5;

    const duration = tracker.run(UP);
    assert.equal(duration, UP_TIME * 1.1, 'a full travel, plus the arrival margin');

    time.advance(UP_TIME * 0.5);
    assert.equal(tracker.arrived(), false, 'only the optimistic estimate has arrived');

    time.advance(UP_TIME * 0.6);
    assert.equal(tracker.arrived(), true);
});

test('a stop after the blind has already reached the end is an exact fix', () => {
    // Someone presses UP, waits, then presses STOP out of habit. The motor has
    // been sitting against its limit switch for seconds — that is a fact about
    // the blind, not a reading off our clock.
    const { tracker, time } = known(0.5);
    tracker.run(UP);
    time.advance(UP_TIME * 2);

    tracker.halt('rx');
    assert.equal(tracker.at(), 1);
    assert.equal(tracker.uncertainty, 0);
});

test('redirecting a moving blind carries the drift of the leg it interrupts', () => {
    const { tracker, time } = known(1);

    tracker.run(DOWN);
    time.advance(6000);
    const duration = tracker.run(UP);

    assert.equal(tracker.at(), 0.8, 'the downward leg counted');
    assert.equal(round(tracker.uncertainty), 0.03);
    assert.equal(duration, Math.round((1 - 0.77) * UP_TIME * 1.1));
});

test('an end position is planned as a limit run, never as a timed one', () => {
    const { tracker } = known(0.5);

    for (const [target, direction] of [[1, UP], [0, DOWN]]) {
        const legs = tracker.plan(target);
        assert.equal(legs.length, 1);
        assert.equal(legs[0].direction, direction);
        assert.equal(legs[0].limit, true, 'let the motor stop itself, and learn where it is');
    }
});

test('an intermediate position from a known start is one timed leg', () => {
    const { tracker } = known(1);

    assert.deepEqual(tracker.plan(0.6), [
        { direction: DOWN, limit: false, duration: 0.4 * DOWN_TIME },
    ]);
});

test('a move too small to be worth making is planned as nothing', () => {
    const { tracker } = known(0.5);

    assert.deepEqual(tracker.plan(0.5), []);
    assert.deepEqual(tracker.plan(0.52), [], `${0.02 * UP_TIME}ms is under the deadband`);
    assert.equal(tracker.plan(0.55).length, 1, `${0.05 * UP_TIME}ms is over it`);
    assert.ok(0.02 * UP_TIME < MIN_MOVE_MS && 0.05 * UP_TIME > MIN_MOVE_MS);
});

test('too uncertain to time, so anchor against the open end stop first', () => {
    const { tracker } = known(0.5);
    tracker.uncertainty = 1;

    assert.deepEqual(tracker.plan(0.9), [
        { direction: UP, limit: true, duration: UP_TIME * 1.1 },
        { direction: DOWN, limit: false, duration: 0.1 * DOWN_TIME },
    ]);

    // The top even for a target the bottom would reach sooner, which it would
    // here: the move then never extends past the position that was asked for.
    assert.deepEqual(tracker.plan(0.1), [
        { direction: UP, limit: true, duration: UP_TIME * 1.1 },
        { direction: DOWN, limit: false, duration: 0.9 * DOWN_TIME },
    ]);
    assert.ok(DOWN_TIME * 1.1 + 0.1 * UP_TIME < UP_TIME * 1.1 + 0.9 * DOWN_TIME);
});

test('a confident estimate is left alone; an uncertain one is repaired', () => {
    const { tracker } = known(0.5);

    tracker.uncertainty = MAX_UNCERTAINTY;
    assert.equal(tracker.plan(0.8).length, 1, 'still worth timing from here');

    tracker.uncertainty = MAX_UNCERTAINTY + 0.01;
    assert.equal(tracker.plan(0.8).length, 2, 'no longer worth timing from here');
});

test('the second leg of a repaired move is timed from the end stop, not the guess', () => {
    const { tracker } = known(0.2);
    tracker.uncertainty = 1;

    const [, timed] = tracker.plan(0.9);
    // Anchored at the top, so the timed leg covers 1 -> 0.9, whatever the
    // estimate happened to say when the move was asked for.
    assert.equal(timed.duration, 0.1 * DOWN_TIME);
});

test('a target that lands on the anchor drops the timed leg', () => {
    const { tracker } = known(0.5);
    tracker.uncertainty = 1;

    // 0.99 is within the deadband of the top the run already ends at.
    assert.deepEqual(tracker.plan(0.99), [
        { direction: UP, limit: true, duration: UP_TIME * 1.1 },
    ]);
});

test('changing the travel times changes what is planned', () => {
    const { tracker } = known(1);
    assert.equal(tracker.plan(0.5)[0].duration, 0.5 * DOWN_TIME);

    tracker.retime(UP_TIME, 60000);
    assert.equal(tracker.plan(0.5)[0].duration, 30000);
});

const round = value => Math.round(value * 1e6) / 1e6;
