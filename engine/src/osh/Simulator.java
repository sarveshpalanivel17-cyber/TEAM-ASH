package osh;

import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;

/** CLI driver: java -cp out osh.Simulator key=value ... ; prints one JSON object per line (events, then SUMMARY). */
public final class Simulator {
    private static final Object OUT = new Object();
    private static void print(String s) { synchronized (OUT) { System.out.println(s); System.out.flush(); } }
    private static String f(double d) { return String.format(Locale.ROOT, "%.3f", d); }
    private static void fail(String m) { print("{\"type\":\"ERROR\",\"message\":\"" + m.replace("\\", "/").replace("\"", "'") + "\"}"); System.exit(2); }

    private static int num(Map<String, String> a, String k, int def, int lo, int hi) {
        String v = a.remove(k); if (v == null) return def;
        try { int n = Integer.parseInt(v); if (n < lo || n > hi) fail(k + " must be between " + lo + " and " + hi); return n; }
        catch (NumberFormatException e) { fail(k + " must be an integer"); return def; }
    }

    // Metrics; mutated only inside the engine listener (which runs under the engine lock) or after all workers finished.
    private static long t0;
    private static final Map<Long, Long> arrival = new HashMap<>();
    private static double rWaitSum, wWaitSum, rWaitMax, wWaitMax;
    private static int overlapViol, rGrants, wGrants, rDone, wDone, cancelled, maxQ, curReaders, maxReaders, fifoViol, prefViol, batchViol;
    private static boolean curWriter; private static long lastGrant;

    private static final Object GATE = new Object();
    private static boolean paused; private static long pausedNanos, pausedSince; private static QueueRWLock LOCK;
    private static void gate() { synchronized (GATE) { while (paused) { try { GATE.wait(); } catch (InterruptedException e) { Thread.currentThread().interrupt(); return; } } } }
    private static void control(String cmd) {
        synchronized (GATE) {
            if (cmd.equals("pause") && !paused) { paused = true; pausedSince = System.nanoTime(); emitControl("PAUSED", "Paused: no new requests are issued until resumed (requests already queued still drain)."); }
            else if (cmd.equals("resume") && paused) { paused = false; pausedNanos += System.nanoTime() - pausedSince; GATE.notifyAll(); emitControl("RESUMED", "Resumed."); }
        }
    }
    private static void emitControl(String type, String text) { if (LOCK != null) line(LOCK, type, text); }
    private static void line(QueueRWLock lock, String type, String text) {
        String q = lock.snapshot(); int ql = q.isEmpty() ? 0 : q.split(",").length;
        print("{\"type\":\"" + type + "\",\"t\":" + f((System.nanoTime() - t0) / 1e6) + ",\"ticket\":0,\"kind\":\"-\",\"queue\":\"" + q + "\",\"queueLen\":" + ql
            + ",\"activeReaders\":" + curReaders + ",\"writerActive\":" + curWriter + ",\"text\":\"" + text + "\"}");
    }
    private static void pause() { gate(); try { Thread.sleep(250); } catch (InterruptedException e) { Thread.currentThread().interrupt(); } }
    private static void note(QueueRWLock lock, String text) { line(lock, "NOTE", text); pause(); }
    private static void rel(QueueRWLock lock, QueueRWLock.Req r) { lock.release(r); if (r.writer) wDone++; else rDone++; pause(); }
    private static String labels(List<QueueRWLock.Req> l) { StringJoiner j = new StringJoiner(","); for (QueueRWLock.Req r : l) j.add(r.label()); return l.isEmpty() ? "none" : j.toString(); }

    /** Deterministic, single-threaded demonstrations driven directly against the real engine. */
    private static void scenario(QueueRWLock lock, String scen, int batch, AtomicInteger errors) {
        if (scen.equals("cancel")) {
            note(lock, "Scenario: R1 is active, W2 waits behind it, R3 waits behind W2. Then W2 is cancelled.");
            QueueRWLock.Req r1 = lock.request(false); pause(); QueueRWLock.Req w2 = lock.request(true); pause(); QueueRWLock.Req r3 = lock.request(false); pause();
            note(lock, "R3 is blocked because W2 is ahead of it in the queue; a reader may not overtake a waiting writer.");
            lock.cancel(w2.ticket); pause();
            if (r3.isGranted()) note(lock, "W2 was cancelled and skipped. Admission re-ran on cancellation, so R3 was granted and shares access with R1.");
            else { errors.incrementAndGet(); note(lock, "FAILURE: R3 was not granted after W2 was cancelled."); }
            rel(lock, r1); if (r3.isGranted()) rel(lock, r3);
            note(lock, "R1 and R3 released. Queue is empty and nothing holds the lock.");
        } else {
            note(lock, "Scenario: R1..R6, W7, R8 arrive in order. Reader batch limit: " + (batch == 0 ? "unlimited" : batch) + ".");
            List<QueueRWLock.Req> all = new ArrayList<>();
            for (int i = 1; i <= 8; i++) { all.add(lock.request(i == 7)); pause(); }
            List<QueueRWLock.Req> act = new ArrayList<>(); for (QueueRWLock.Req r : all) if (r.isGranted()) act.add(r);
            note(lock, "All 8 requests have arrived. Admitted immediately: " + labels(act) + ". Waiting: " + lock.snapshot() + ".");
            for (int round = 1; !act.isEmpty(); round++) {
                note(lock, "Batch " + round + " is active: " + labels(act) + ".");
                for (QueueRWLock.Req r : act) rel(lock, r);
                act = new ArrayList<>(); for (QueueRWLock.Req r : all) if (r.isGranted()) act.add(r);
                note(lock, "Batch " + round + " released. Admission decision: now admitted " + labels(act) + "; still waiting: " + (lock.snapshot().isEmpty() ? "none" : lock.snapshot()) + ".");
            }
        }
    }

    public static void main(String[] args) throws Exception {
        Map<String, String> a = new HashMap<>();
        for (String s : args) { int i = s.indexOf('='); if (i < 1) fail("bad argument: " + s); a.put(s.substring(0, i), s.substring(i + 1)); }
        String pol = a.remove("policy"); if (pol == null) pol = "FIFO";
        final QueueRWLock.Policy policy;
        if (pol.equals("FIFO")) policy = QueueRWLock.Policy.FIFO; else if (pol.equals("WRITER_PREF")) policy = QueueRWLock.Policy.WRITER_PREF;
        else { fail("policy must be FIFO or WRITER_PREF"); return; }
        int readers = num(a, "readers", 10, 0, 100), writers = num(a, "writers", 5, 0, 100), ops = num(a, "ops", 4, 1, 100);
        int threads = num(a, "threads", 8, 1, 16), batch = num(a, "batch", 0, 0, 100), readMs = num(a, "readMs", 5, 0, 200);
        int writeMs = num(a, "writeMs", 10, 0, 200), cancelPct = num(a, "cancelPct", 0, 0, 50), seed = num(a, "seed", 42, 0, Integer.MAX_VALUE);
        String scen = a.remove("scenario"); if (scen == null) scen = "none";
        if (!List.of("none", "cancel", "batch").contains(scen)) fail("scenario must be none, cancel or batch");
        if (!a.isEmpty()) fail("unknown option(s): " + a.keySet());
        int total = scen.equals("none") ? (readers + writers) * ops : scen.equals("cancel") ? 3 : 8;
        if (scen.equals("none") && total > 100) fail("(readers + writers) * ops must be at most 100, got " + total);

        t0 = System.nanoTime();
        QueueRWLock lock = new QueueRWLock(policy, batch, (type, ticket, writer, queue) -> {
            long now = System.nanoTime(); int ql = queue.isEmpty() ? 0 : queue.split(",").length; maxQ = Math.max(maxQ, ql);
            Double wait = null;
            switch (type) {
                case "REQUEST_ARRIVED": arrival.put(ticket, now); break;
                case "GRANTED_READ": case "GRANTED_WRITE": {
                    double w = (now - arrival.remove(ticket)) / 1e6; wait = w;
                    if (writer ? (curWriter || curReaders > 0) : curWriter) overlapViol++;
                    if (writer) { wGrants++; wWaitSum += w; wWaitMax = Math.max(wWaitMax, w); curWriter = true; }
                    else { rGrants++; rWaitSum += w; rWaitMax = Math.max(rWaitMax, w); curReaders++; maxReaders = Math.max(maxReaders, curReaders);
                           if (batch > 0 && curReaders > batch) batchViol++;
                           if (policy == QueueRWLock.Policy.WRITER_PREF && queue.contains("W")) prefViol++; }
                    if (policy == QueueRWLock.Policy.FIFO) { if (ticket < lastGrant) fifoViol++; lastGrant = ticket; }
                    break; }
                case "CANCELLED": arrival.remove(ticket); cancelled++; break;
                case "RELEASED": if (writer) curWriter = false; else curReaders--; break;
                case "READ_COMPLETED": rDone++; break;
                case "WRITE_COMPLETED": wDone++; break;
                default: break;
            }
            print("{\"type\":\"" + type + "\",\"t\":" + f((now - t0) / 1e6) + ",\"ticket\":" + ticket + ",\"kind\":\"" + (writer ? "W" : "R")
                + "\",\"queue\":\"" + queue + "\",\"queueLen\":" + ql + ",\"activeReaders\":" + curReaders + ",\"writerActive\":" + curWriter
                + (wait != null ? ",\"waitMs\":" + f(wait) : "") + "}");
        });

        LOCK = lock;
        Thread in = new Thread(() -> { try (java.io.BufferedReader br = new java.io.BufferedReader(new java.io.InputStreamReader(System.in))) { for (String l; (l = br.readLine()) != null; ) control(l.trim()); } catch (java.io.IOException e) { /* stdin closed */ } });
        in.setDaemon(true); in.start();
        AtomicInteger errors = new AtomicInteger();
        if (!scen.equals("none")) scenario(lock, scen, batch, errors);
        else {
        List<Boolean> tasks = new ArrayList<>();
        for (int i = 0; i < readers * ops; i++) tasks.add(false);
        for (int i = 0; i < writers * ops; i++) tasks.add(true);
        Collections.shuffle(tasks, new Random(seed));

        ExecutorService pool = Executors.newFixedThreadPool(threads);
        ScheduledExecutorService sched = Executors.newSingleThreadScheduledExecutor(r -> { Thread t = new Thread(r); t.setDaemon(true); return t; });
        for (int i = 0; i < tasks.size(); i++) {
            final boolean w = tasks.get(i); final boolean cancelIt = (i % 100) < cancelPct;
            pool.submit(() -> {
                try {
                    gate();
                    QueueRWLock.Req r = lock.request(w);
                    if (cancelIt) sched.schedule(() -> lock.cancel(r.ticket), 20, TimeUnit.MILLISECONDS);
                    lock.run(r, () -> { try { Thread.sleep(w ? writeMs : readMs); } catch (InterruptedException e) { Thread.currentThread().interrupt(); } });
                } catch (CancellationException e) { /* counted via CANCELLED event */
                } catch (Throwable e) { errors.incrementAndGet(); print("{\"type\":\"ERROR\",\"message\":\"" + e.toString().replace("\"","'") + "\"}"); }
            });
        }
        pool.shutdown();
        if (!pool.awaitTermination(120, TimeUnit.SECONDS)) fail("workers did not finish");
        sched.shutdownNow();
        }
        double elapsed = (System.nanoTime() - t0 - pausedNanos) / 1e6; int done = rDone + wDone;
        boolean safety = lock.violations() == 0 && overlapViol == 0, clean = lock.queueSize() == 0 && lock.activeReaders() == 0 && !lock.writerActive();
        boolean accounted = done + cancelled + errors.get() == total;
        boolean policyOk = fifoViol == 0 && prefViol == 0, batchOk = batchViol == 0;
        print("{\"type\":\"SUMMARY\",\"policy\":\"" + policy + "\",\"batch\":" + batch + ",\"totalRequests\":" + total + ",\"completed\":" + done
            + ",\"readsCompleted\":" + rDone + ",\"writesCompleted\":" + wDone + ",\"cancelled\":" + cancelled + ",\"errors\":" + errors.get()
            + ",\"avgReaderWaitMs\":" + f(rGrants == 0 ? 0 : rWaitSum / rGrants) + ",\"maxReaderWaitMs\":" + f(rWaitMax)
            + ",\"avgWriterWaitMs\":" + f(wGrants == 0 ? 0 : wWaitSum / wGrants) + ",\"maxWriterWaitMs\":" + f(wWaitMax)
            + ",\"elapsedMs\":" + f(elapsed) + ",\"throughputOpsPerSec\":" + f(elapsed == 0 ? 0 : done / (elapsed / 1000.0))
            + ",\"maxQueueLength\":" + maxQ + ",\"maxConcurrentReaders\":" + maxReaders + ",\"violations\":" + lock.violations()
            + ",\"checks\":{\"noReaderWriterOverlap\":" + safety + ",\"lockReleasedAndQueueEmpty\":" + clean + ",\"allRequestsAccounted\":" + accounted
            + ",\"policyOrderRespected\":" + policyOk + ",\"batchLimitRespected\":" + batchOk + "}}");
        System.exit(safety && clean && accounted && policyOk && batchOk ? 0 : 3);
    }
}
