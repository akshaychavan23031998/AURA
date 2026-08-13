export default function HomePage() {
  return (
    <main className="grid min-h-screen place-items-center px-6 py-16">
      <section className="max-w-3xl text-center" aria-labelledby="aura-heading">
        <p className="mb-5 text-sm font-medium tracking-[0.24em] text-[var(--accent)] uppercase">
          Foundation initialized
        </p>
        <h1
          id="aura-heading"
          className="text-6xl font-semibold tracking-[0.18em] sm:text-8xl"
        >
          AURA
        </h1>
        <p className="mt-6 text-lg leading-8 text-[var(--muted)] sm:text-xl">
          Self-Hosted Multilingual Autonomous Voice Agent
        </p>
      </section>
    </main>
  );
}
