import osh.QueueRWLock;
import osh.QueueRWLock.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

public class Tests {
    static int pass, fail;
    static void check(String name, boolean ok) { System.out.println((ok ? "PASS " : "FAIL ") + name); if (ok) pass++; else fail++; }
    static String gr(Req... rs) { StringBuilder s = new StringBuilder(); for (Req r : rs) s.append(r.isGranted() ? '1' : '0'); return s.toString(); }

    public static void main(String[] a) throws Exception {
        // FIFO admission: W1 active; R2 R3 W4 R5 queued
        { QueueRWLock l = new QueueRWLock(Policy.FIFO, 0, null);
          Req w1 = l.request(true), r2 = l.request(false), r3 = l.request(false), w4 = l.request(true), r5 = l.request(false);
          boolean s1 = gr(w1, r2, r3, w4, r5).equals("10000");
          l.release(w1); boolean s2 = gr(r2, r3, w4, r5).equals("1100");
          l.release(r2); boolean s3 = !w4.isGranted(); l.release(r3);
          boolean s4 = gr(w4, r5).equals("10"); l.release(w4); boolean s5 = r5.isGranted(); l.release(r5);
          check("FIFO admission order", s1 && s2 && s3 && s4 && s5);
          check("Queue cleanup after FIFO scenario", l.queueSize() == 0 && l.activeReaders() == 0 && !l.writerActive()); }
        // Writer preference
        { QueueRWLock l = new QueueRWLock(Policy.WRITER_PREF, 0, null);
          Req r1 = l.request(false), w2 = l.request(true), r3 = l.request(false);
          boolean s1 = gr(r1, w2, r3).equals("100"); l.release(r1);
          boolean s2 = gr(w2, r3).equals("10"); l.release(w2);
          check("Writer preference over newly arriving reader", s1 && s2 && r3.isGranted()); }
        // Concurrent readers & exclusive writer (real threads)
        { QueueRWLock l = new QueueRWLock(Policy.FIFO, 0, null);
          CountDownLatch together = new CountDownLatch(3); AtomicBoolean allIn = new AtomicBoolean();
          List<Thread> ts = new ArrayList<>();
          for (int i = 0; i < 3; i++) { Req r = l.request(false); Thread t = new Thread(() -> { try { l.run(r, () -> { together.countDown(); try { allIn.set(together.await(5, TimeUnit.SECONDS)); } catch (InterruptedException e) {} }); } catch (Exception e) {} }); ts.add(t); t.start(); }
          for (Thread t : ts) t.join();
          check("Concurrent readers (3 inside at once)", allIn.get());
          Req w1 = l.request(true), w2 = l.request(true); AtomicInteger in = new AtomicInteger(), max = new AtomicInteger();
          Runnable work = () -> { max.accumulateAndGet(in.incrementAndGet(), Math::max); try { Thread.sleep(20); } catch (InterruptedException e) {} in.decrementAndGet(); };
          Thread a1 = new Thread(() -> { try { l.run(w1, work); } catch (Exception e) {} }), a2 = new Thread(() -> { try { l.run(w2, work); } catch (Exception e) {} });
          a1.start(); a2.start(); a1.join(); a2.join();
          check("Exclusive writers (max 1 inside)", max.get() == 1 && l.violations() == 0); }
        // Batch limits
        for (int max : new int[]{3, 0}) { QueueRWLock l = new QueueRWLock(Policy.FIFO, max, null);
          Req[] r = new Req[9]; for (int i = 1; i <= 8; i++) r[i] = l.request(i == 7);
          if (max == 3) {
            boolean s1 = gr(r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8]).equals("11100000");
            for (int i = 1; i <= 3; i++) l.release(r[i]);
            boolean s2 = gr(r[4], r[5], r[6], r[7], r[8]).equals("11100");
            for (int i = 4; i <= 6; i++) l.release(r[i]);
            boolean s3 = gr(r[7], r[8]).equals("10"); l.release(r[7]); boolean s4 = r[8].isGranted();
            check("Reader batch limit 3 enforced in engine", s1 && s2 && s3 && s4);
          } else {
            boolean s1 = gr(r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8]).equals("11111100");
            check("Unlimited reader batching (R1-R6 together, W7 and R8 wait)", s1);
          } }
        // Cancellation handoff
        { QueueRWLock l = new QueueRWLock(Policy.FIFO, 0, null);
          Req r1 = l.request(false), w = l.request(true), r2 = l.request(false);
          AtomicReference<Throwable> err = new AtomicReference<>(); Thread t = new Thread(() -> { try { w.await(); } catch (Throwable e) { err.set(e); } }); t.start(); Thread.sleep(100);
          boolean pre = !r2.isGranted() && l.snapshot().equals("W2,R3");
          boolean c = l.cancel(w.ticket); t.join(2000);
          check("Cancellation handoff: cancelled waiter skipped, R2 admitted", pre && c && err.get() instanceof CancellationException && r2.isGranted() && l.snapshot().isEmpty());
          check("Cancel of granted request rejected", !l.cancel(r1.ticket)); l.release(r1); l.release(r2); }
        // Interrupted request
        { QueueRWLock l = new QueueRWLock(Policy.FIFO, 0, null);
          Req w1 = l.request(true), r2 = l.request(false); AtomicReference<Throwable> err = new AtomicReference<>();
          Thread t = new Thread(() -> { try { r2.await(); } catch (Throwable e) { err.set(e); } }); t.start(); Thread.sleep(100); t.interrupt(); t.join(2000);
          boolean clean = err.get() instanceof InterruptedException && l.queueSize() == 0;
          l.release(w1); Req r3 = l.request(false);
          check("Interrupted waiter cleaned up; lock still usable", clean && r3.isGranted()); l.release(r3);
          boolean bad = false; try { l.release(r3); } catch (IllegalStateException e) { bad = true; }
          check("Invalid double release rejected", bad); }
        // Exception in work does not leave lock held
        { QueueRWLock l = new QueueRWLock(Policy.FIFO, 0, null); Req w = l.request(true);
          try { l.run(w, () -> { throw new RuntimeException("x"); }); } catch (RuntimeException e) {}
          check("Exception in critical section releases lock", !l.writerActive() && l.request(true).isGranted()); }
        // Empty workload
        { QueueRWLock l = new QueueRWLock(Policy.WRITER_PREF, 0, null);
          check("Empty workload leaves idle state", l.queueSize() == 0 && l.activeReaders() == 0 && !l.writerActive() && l.violations() == 0); }
        // Repeated stress
        for (QueueRWLock.Policy p : QueueRWLock.Policy.values()) for (int batch : new int[]{0, 4}) {
            boolean ok = true;
            for (int rep = 0; rep < 5 && ok; rep++) {
                QueueRWLock l = new QueueRWLock(p, batch, null); ExecutorService ex = Executors.newFixedThreadPool(16); AtomicInteger done = new AtomicInteger();
                int total = 16 * 150; Random rnd = new Random(rep);
                for (int i = 0; i < total; i++) { boolean w = rnd.nextInt(10) < 3; ex.submit(() -> { try { l.run(l.request(w), () -> Thread.onSpinWait()); done.incrementAndGet(); } catch (Exception e) {} }); }
                ex.shutdown(); ok = ex.awaitTermination(30, TimeUnit.SECONDS) && done.get() == total && l.violations() == 0 && l.queueSize() == 0 && l.activeReaders() == 0 && !l.writerActive();
            }
            check("Stress 5x2400 ops policy=" + p + " batch=" + batch, ok); }
        System.out.println("RESULT passed=" + pass + " failed=" + fail);
        System.exit(fail == 0 ? 0 : 1);
    }
}
