package osh;

import java.util.*;
import java.util.concurrent.CancellationException;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.locks.*;

/**
 * Reader-writer lock with an explicit monitor-protected ticket queue (no busy waiting).
 * FIFO: strict arrival-order admission; consecutive readers at the head are admitted together,
 *   a writer at the head blocks everything behind it. No starvation of either side.
 * WRITER_PREF: while any writer waits, no reader is admitted; waiting writers go in ticket order.
 *   Writers cannot starve; readers CAN starve under a continuous writer stream (documented limitation).
 * Batching (maxBatch>0): at most maxBatch readers are admitted per batch; a batch ends only when all
 *   its readers released, then the next batch starts. maxBatch==0 means unlimited.
 * Cancellation/interruption of a waiter removes its entry and re-runs admission, so no wakeup is lost.
 */
public final class QueueRWLock {
    public enum Policy { FIFO, WRITER_PREF }
    public interface Listener { void on(String type, long ticket, boolean writer, String queue); }

    public final class Req {
        public final long ticket; public final boolean writer;
        private boolean granted, cancelled, released;
        private final Condition cond = lock.newCondition();
        private Req(long t, boolean w) { ticket = t; writer = w; }
        public String label() { return (writer ? "W" : "R") + ticket; }
        public boolean isGranted() { lock.lock(); try { return granted && !released; } finally { lock.unlock(); } }
        public boolean isCancelled() { lock.lock(); try { return cancelled; } finally { lock.unlock(); } }
        /** Blocks until granted. Throws CancellationException if cancelled, InterruptedException if interrupted (queue state cleaned). */
        public void await() throws InterruptedException {
            lock.lock();
            try {
                while (!granted && !cancelled) cond.await();
                if (cancelled) throw new CancellationException(label());
            } catch (InterruptedException e) {
                if (granted && !released) releaseLocked(this); else if (!cancelled) cancelLocked(this, "INTERRUPTED");
                throw e;
            } finally { lock.unlock(); }
        }
    }

    private final ReentrantLock lock = new ReentrantLock();
    private final LinkedList<Req> queue = new LinkedList<>();
    private final Policy policy; private final int maxBatch; private final Listener out;
    private long seq; private int active, batchCount; private boolean writerActive;
    private final AtomicInteger readersInside = new AtomicInteger(), writersInside = new AtomicInteger(), violations = new AtomicInteger();

    public QueueRWLock(Policy p, int maxBatch, Listener l) {
        if (maxBatch < 0) throw new IllegalArgumentException("maxBatch");
        policy = Objects.requireNonNull(p); this.maxBatch = maxBatch; out = l == null ? (a, b, c, d) -> {} : l;
    }

    /** Non-blocking: enqueues a request, runs admission. Call req.await() to block. */
    public Req request(boolean writer) {
        lock.lock();
        try {
            Req r = new Req(++seq, writer);
            emit("REQUEST_ARRIVED", r);
            queue.addLast(r);
            dispatch();
            if (!r.granted) emit("QUEUED", r);
            return r;
        } finally { lock.unlock(); }
    }

    public void release(Req r) { lock.lock(); try { releaseLocked(r); } finally { lock.unlock(); } }

    /** Cancels a still-waiting request. Returns false if already granted/cancelled/unknown. */
    public boolean cancel(long ticket) {
        lock.lock();
        try {
            for (Req r : queue) if (r.ticket == ticket) { cancelLocked(r, "CANCELLED"); return true; }
            return false;
        } finally { lock.unlock(); }
    }

    /** Full lifecycle: await, run work with overlap checking, always release. */
    public void run(Req r, Runnable work) throws InterruptedException {
        r.await();
        try {
            emitSafe(r.writer ? "WRITE_STARTED" : "READ_STARTED", r);
            if (r.writer) { if (writersInside.incrementAndGet() > 1 || readersInside.get() > 0) violations.incrementAndGet(); }
            else { readersInside.incrementAndGet(); if (writersInside.get() > 0) violations.incrementAndGet(); }
            try { work.run(); }
            finally {
                if (r.writer) writersInside.decrementAndGet(); else readersInside.decrementAndGet();
                emitSafe(r.writer ? "WRITE_COMPLETED" : "READ_COMPLETED", r);
            }
        } finally { release(r); }
    }

    public int violations() { return violations.get(); }
    public int queueSize() { lock.lock(); try { return queue.size(); } finally { lock.unlock(); } }
    public int activeReaders() { lock.lock(); try { return active; } finally { lock.unlock(); } }
    public boolean writerActive() { lock.lock(); try { return writerActive; } finally { lock.unlock(); } }
    public String snapshot() { lock.lock(); try { return snap(); } finally { lock.unlock(); } }

    // ---- everything below runs with `lock` held ----
    private String snap() { StringJoiner j = new StringJoiner(","); for (Req q : queue) j.add(q.label()); return j.toString(); }
    private void emitSafe(String type, Req r) { lock.lock(); try { emit(type, r); } finally { lock.unlock(); } }
    private void emit(String type, Req r) { out.on(type, r.ticket, r.writer, snap()); }

    private void releaseLocked(Req r) {
        if (!r.granted || r.released) throw new IllegalStateException("invalid release of " + r.label());
        r.released = true;
        if (r.writer) { writerActive = false; batchCount = 0; }
        else if (--active == 0) batchCount = 0;
        emit("RELEASED", r);
        dispatch();
    }

    private void cancelLocked(Req r, String type) {
        queue.remove(r); r.cancelled = true; r.cond.signal();
        emit(type.equals("INTERRUPTED") ? "CANCELLED" : type, r);
        dispatch(); // removed entry may have been blocking others
    }

    private boolean batchOk() { return maxBatch == 0 || batchCount < maxBatch; }

    private void grant(Req r) {
        queue.remove(r); r.granted = true;
        if (r.writer) writerActive = true; else { active++; batchCount++; }
        emit(r.writer ? "GRANTED_WRITE" : "GRANTED_READ", r);
        r.cond.signal();
    }

    private void dispatch() {
        if (policy == Policy.FIFO) {
            for (Req h; (h = queue.peekFirst()) != null; ) {
                if (h.writer) { if (!writerActive && active == 0) grant(h); return; }
                if (writerActive || !batchOk()) return;
                grant(h);
            }
        } else {
            if (writerActive) return;
            Req w = null; for (Req q : queue) if (q.writer) { w = q; break; }
            if (w != null) { if (active == 0) grant(w); return; }
            for (Req h; (h = queue.peekFirst()) != null && batchOk(); ) grant(h);
        }
    }
}
