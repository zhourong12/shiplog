import { Check, Github, Ruler, ShieldCheck, Sparkles, Sprout } from "lucide-react";
import type { ReactNode } from "react";
import { Notice } from "../components/ui";
import { useI18n, type TranslationKey } from "../i18n";

function Step({ index, title, body }: { index: number; title: string; body: string }) {
  return (
    <li className="landing-step">
      <span className="landing-step-index" aria-hidden="true">
        {index}
      </span>
      <h3>{title}</h3>
      <p>{body}</p>
    </li>
  );
}

function Trust({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <li className="landing-trust">
      {icon}
      <h3>{title}</h3>
      <p>{body}</p>
    </li>
  );
}

/** Shown to signed-out visitors when the server runs with GitHub sign-in. */
export function LandingPage({ loginError }: { loginError: boolean }) {
  const { t } = useI18n();
  const loginHref = `/auth/github/login?next=${encodeURIComponent("/")}`;
  const plan = (prefix: "landing.free" | "landing.pro") =>
    (["f1", "f2", "f3"] as const).map((key) => t(`${prefix}.${key}` as TranslationKey));

  return (
    <div className="landing">
      <section className="landing-hero">
        <h1>{t("landing.title")}</h1>
        <p className="landing-lead">{t("landing.subtitle")}</p>
        {loginError ? <Notice tone="warning">{t("landing.loginError")}</Notice> : null}
        <div className="actions landing-actions">
          <a className="btn btn-primary btn-large" href={loginHref}>
            <Github aria-hidden="true" size={18} />
            {t("landing.cta")}
          </a>
          <a className="btn btn-quiet btn-large" href="#how">
            {t("landing.ctaSecondary")}
          </a>
        </div>
      </section>

      <section id="how" className="landing-section" aria-labelledby="how-title">
        <h2 id="how-title">{t("landing.how")}</h2>
        <ol className="landing-steps">
          <Step index={1} title={t("landing.how1.title")} body={t("landing.how1.body")} />
          <Step index={2} title={t("landing.how2.title")} body={t("landing.how2.body")} />
          <Step index={3} title={t("landing.how3.title")} body={t("landing.how3.body")} />
        </ol>
      </section>

      <section className="landing-section" aria-labelledby="trust-title">
        <h2 id="trust-title">{t("landing.trust")}</h2>
        <ul className="landing-trusts">
          <Trust
            icon={<Sparkles aria-hidden="true" size={22} />}
            title={t("landing.trust1.title")}
            body={t("landing.trust1.body")}
          />
          <Trust
            icon={<ShieldCheck aria-hidden="true" size={22} />}
            title={t("landing.trust2.title")}
            body={t("landing.trust2.body")}
          />
          <Trust
            icon={<Ruler aria-hidden="true" size={22} />}
            title={t("landing.trust3.title")}
            body={t("landing.trust3.body")}
          />
        </ul>
      </section>

      <section className="landing-section" aria-labelledby="pricing-title">
        <h2 id="pricing-title">{t("landing.pricing")}</h2>
        <div className="pricing">
          {(["landing.free", "landing.pro"] as const).map((prefix) => (
            <article
              key={prefix}
              className={`price-card${prefix === "landing.pro" ? " price-pro" : ""}`}
            >
              <h3>
                {prefix === "landing.pro" ? <Sprout aria-hidden="true" size={18} /> : null}
                {t(`${prefix}.name` as TranslationKey)}
              </h3>
              <p className="price">{t(`${prefix}.price` as TranslationKey)}</p>
              <ul>
                {plan(prefix).map((feature) => (
                  <li key={feature}>
                    <Check aria-hidden="true" size={16} />
                    {feature}
                  </li>
                ))}
              </ul>
              <a
                className={`btn ${prefix === "landing.pro" ? "btn-primary" : "btn-quiet"}`}
                href={loginHref}
              >
                {t(prefix === "landing.pro" ? "landing.pro.cta" : "landing.cta")}
              </a>
            </article>
          ))}
        </div>
      </section>

      <section className="landing-section" aria-labelledby="faq-title">
        <h2 id="faq-title">{t("landing.faq")}</h2>
        <dl className="faq">
          {(["faq1", "faq2", "faq3"] as const).map((key) => (
            <div key={key}>
              <dt>{t(`landing.${key}.q` as TranslationKey)}</dt>
              <dd>{t(`landing.${key}.a` as TranslationKey)}</dd>
            </div>
          ))}
        </dl>
      </section>

      <footer className="landing-footer">{t("landing.footer")}</footer>
    </div>
  );
}
