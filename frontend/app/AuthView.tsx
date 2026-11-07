"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import { AlertCircle, ArrowLeft, ArrowRight, Bot, Command, Eye, EyeOff, LoaderCircle, Lock, Mail, ShieldCheck, User } from "lucide-react";
import { requestJson, type AuthUser } from "./contracts";

declare global {
  interface Window {
    google?: any;
  }
}

function NexoLogo({ className = "" }: { className?: string }) {
  return (
    <div className={`inline-flex items-center gap-3 ${className}`}>
      <div className="flex size-11 items-center justify-center rounded-[14px] bg-white text-[#049DFD] shadow-md">
        <Command size={24} className="stroke-[2.5]" />
      </div>
      <div className="leading-tight">
        <span className="block text-2xl font-black tracking-tight text-white">nexo.</span>
        <span className="block text-[10px] font-bold uppercase tracking-[0.2em] text-white/85">
          Inteligência de Compras
        </span>
      </div>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg className="size-5 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82Z" />
      <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09C3.26 21.3 7.31 24 12 24Z" />
      <path fill="#FBBC05" d="M5.27 14.29c-.25-.72-.38-1.49-.38-2.29s.13-1.57.38-2.29V6.62H1.29a11.99 11.99 0 0 0 0 10.76l3.98-3.09Z" />
      <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.98 3.09c.95-2.85 3.6-4.96 6.73-4.96Z" />
    </svg>
  );
}

export default function AuthView({ initialMode }: { initialMode: "login" | "register" }) {
  const router = useRouter();
  const [mode, setMode] = useState<"login" | "register">(initialMode);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [error, setError] = useState("");
  const [googleClientId, setGoogleClientId] = useState<string | null>(process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || null);

  function finishAuth(payload: { token: string; user: AuthUser }) {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("nexo_token", payload.token);
      window.localStorage.setItem("nexo_user", JSON.stringify(payload.user));
    }
    router.push("/dashboard");
  }

  useEffect(() => {
    if (typeof document !== "undefined" && !document.getElementById("google-gsi-script")) {
      const script = document.createElement("script");
      script.id = "google-gsi-script";
      script.src = "https://accounts.google.com/gsi/client";
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
  }, []);

  useEffect(() => {
    let active = true;

    // Se o usuário retornou do redirect OAuth2 do Google (#access_token=... ou ?code=...)
    if (typeof window !== "undefined") {
      const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
      const queryParams = new URLSearchParams(window.location.search);
      const accessToken = hashParams.get("access_token");
      const idToken = hashParams.get("id_token");
      const code = queryParams.get("code");
      const oauthError = hashParams.get("error") || queryParams.get("error");

      if (oauthError) {
        setError(`Autenticação Google não concluída (${oauthError}).`);
        window.history.replaceState({}, document.title, window.location.pathname);
      } else if (accessToken || idToken || code) {
        setGoogleBusy(true);
        window.history.replaceState({}, document.title, window.location.pathname);
        void requestJson("/auth/google", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            access_token: accessToken || undefined,
            credential: idToken || undefined,
            code: code || undefined,
            redirect_uri: `${window.location.origin}${window.location.pathname}`,
          }),
        })
          .then((res: any) => {
            if (active && res?.token && res?.user) {
              finishAuth(res);
            }
          })
          .catch((cause: any) => {
            if (active) {
              setError(cause instanceof Error ? cause.message : "Falha ao validar login com o Google.");
              setGoogleBusy(false);
            }
          });
        return () => { active = false; };
      }
    }

    void requestJson("/auth/me")
      .then((res: any) => {
        if (active && res?.user) router.replace("/dashboard");
      })
      .catch(() => {});

    void requestJson("/auth/config")
      .then((cfg: any) => {
        if (active && typeof cfg?.google_client_id === "string" && cfg.google_client_id.trim()) {
          setGoogleClientId(cfg.google_client_id.trim());
        }
      })
      .catch(() => {});

    return () => { active = false; };
  }, [router]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy || googleBusy) return;
    setError("");

    const trimmedEmail = email.trim().toLowerCase();
    const trimmedName = name.trim();

    if (mode === "register" && trimmedName.length < 2) {
      setError("Informe seu nome completo (mínimo de 2 caracteres).");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      setError("Informe um e-mail corporativo válido.");
      return;
    }
    if (password.length < 6) {
      setError("A senha deve ter pelo menos 6 caracteres.");
      return;
    }

    setBusy(true);
    try {
      const endpoint = mode === "register" ? "/auth/register" : "/auth/login";
      const body = mode === "register" ? { name: trimmedName, email: trimmedEmail, password } : { email: trimmedEmail, password };
      const res = (await requestJson(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })) as { token: string; user: AuthUser };
      finishAuth(res);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível autenticar.");
    } finally {
      setBusy(false);
    }
  }

  function startRealGoogleOAuth(activeClientId: string) {
    if (typeof window === "undefined") return;
    setError("");
    setGoogleBusy(true);

    // 1. Tenta o popup oficial Google Identity Services (OAuth 2.0 Token Client)
    if (window.google?.accounts?.oauth2) {
      try {
        const tokenClient = window.google.accounts.oauth2.initTokenClient({
          client_id: activeClientId,
          scope: "openid email profile",
          callback: async (response: any) => {
            if (response?.error) {
              setGoogleBusy(false);
              setError(`Autenticação Google cancelada ou recusada (${response.error}).`);
              return;
            }
            try {
              const res = (await requestJson("/auth/google", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ access_token: response.access_token }),
              })) as { token: string; user: AuthUser };
              finishAuth(res);
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : "Falha ao validar conta Google.");
              setGoogleBusy(false);
            }
          },
          error_callback: (err: any) => {
            setGoogleBusy(false);
            if (err?.type === "popup_closed") {
              setError("A janela de login do Google foi fechada antes de concluir.");
            } else {
              // Fallback automático para redirect OAuth2 oficial do Google caso popup seja bloqueado
              const redirectUri = `${window.location.origin}${window.location.pathname}`;
              const oauthUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(activeClientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=token&scope=${encodeURIComponent("openid email profile")}&prompt=select_account`;
              window.location.href = oauthUrl;
            }
          },
        });
        tokenClient.requestAccessToken({ prompt: "select_account" });
        return;
      } catch {
        // Fallback para redirect OAuth2 completo
      }
    }

    // 2. Fallback direto via Redirect OAuth 2.0 oficial do Google (accounts.google.com)
    const redirectUri = `${window.location.origin}${window.location.pathname}`;
    const oauthUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(activeClientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=token&scope=${encodeURIComponent("openid email profile")}&prompt=select_account`;
    window.location.href = oauthUrl;
  }

  async function handleGoogleClick() {
    if (busy || googleBusy) return;
    setError("");

    if (googleClientId) {
      startRealGoogleOAuth(googleClientId);
      return;
    }

    setError("Google Client ID não encontrado nas configurações.");
  }

  const passwordStrength = password.length === 0 ? 0 : password.length < 6 ? 1 : password.length < 10 ? 2 : 3;

  return (
    <div
      className="relative flex min-h-screen flex-col justify-between overflow-hidden text-white [color-scheme:light] selection:bg-[#019EFD] selection:text-white"
      style={{
        backgroundImage: "linear-gradient(90deg, #059FFD 0%, #4B53FD 100%)",
      }}
    >
      {/* Subtle geometric background rings */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden opacity-20">
        <div className="absolute -right-24 -top-24 size-[520px] rounded-full border-[40px] border-white/30" />
        <div className="absolute -bottom-32 -left-24 size-[460px] rounded-full border-[30px] border-white/20" />
      </div>

      {/* Top Bar */}
      <header className="relative z-10 mx-auto flex w-full max-w-[1140px] items-center justify-between px-5 py-6">
        <Link href="/" className="group transition-transform duration-200 hover:scale-105">
          <NexoLogo />
        </Link>

        <Link
          href="/"
          className="inline-flex items-center gap-2 rounded-[50px] bg-white px-7 py-2.5 text-sm font-extrabold text-[#049DFD] shadow-md transition-all duration-200 hover:scale-105 hover:bg-[#35A6DF] hover:text-white"
        >
          <ArrowLeft size={15} />
          <span>Voltar para a Página Inicial</span>
        </Link>
      </header>

      {/* Main Content */}
      <main className="relative z-10 mx-auto my-auto grid w-full max-w-[1140px] items-center gap-10 px-5 py-8 lg:grid-cols-12">
        {/* Left Column: Nexo Brand & Highlights */}
        <div className="space-y-6 lg:col-span-6">
          <div className="inline-flex items-center rounded-[50px] border-2 border-white bg-[#019EFDC7] px-5 py-1.5 text-sm font-semibold text-white shadow-sm">
            Acesso Corporativo · Nexo Inteligência de Compras
          </div>

          <h1 className="text-[36px] font-black leading-[1.1] tracking-tight text-white sm:text-[50px]">
            Não é apenas IA.
            <br />É eficiência e economia real em compras.
          </h1>

          <p className="text-[16px] font-medium leading-relaxed text-white/95">
            Entre na plataforma Nexo para acionar agentes autônomos em LangGraph, auditar reputação de fornecedores no ReclameAqui, negociar via Telegram e aprovar compras com TCO 100% comprovado.
          </p>

          {/* Dark Box #101827 */}
          <div className="rounded-[20px] bg-[#101827] p-6 text-white shadow-xl">
            <div className="grid grid-cols-2 gap-4 text-center">
              <div>
                <p className="numeric text-[44px] font-black leading-none text-[#019EFD]">90%</p>
                <p className="mt-2 text-xs font-semibold text-white">Redução de tempo em cotações</p>
              </div>
              <div>
                <p className="numeric text-[44px] font-black leading-none text-white">100%</p>
                <p className="mt-2 text-xs font-semibold text-white">TCO auditado com fonte real</p>
              </div>
            </div>
            <div className="mt-5 flex flex-wrap justify-center gap-4 border-t border-white/15 pt-4 text-xs text-slate-300">
              <span className="inline-flex items-center gap-1.5">
                <Bot size={15} className="text-[#019EFD]" /> Agentes LangGraph + Gemini
              </span>
              <span className="inline-flex items-center gap-1.5">
                <ShieldCheck size={15} className="text-[#019EFD]" /> Auditoria ReclameAqui
              </span>
            </div>
          </div>
        </div>

        {/* Right Column: White Card (rounded-[20px], shadow-[0_0_25px_0_rgba(0,0,0,0.45)]) */}
        <div className="lg:col-span-6 lg:flex lg:justify-end">
          <div className="w-full max-w-[460px] rounded-[20px] bg-white p-7 text-[#121212] shadow-[0_0_25px_0_rgba(0,0,0,0.45)] sm:p-9">
            {/* Pill Mode Switcher */}
            <div className="mb-6 grid grid-cols-2 rounded-[50px] bg-[#E9E9E9] p-1">
              <Link
                href="/login"
                onClick={e => { e.preventDefault(); setMode("login"); setError(""); }}
                className={`rounded-[50px] py-2.5 text-center text-xs font-extrabold transition ${
                  mode === "login"
                    ? "bg-[#049DFD] text-white shadow-sm"
                    : "text-[#404040] hover:text-black"
                }`}
              >
                Entrar na Conta
              </Link>
              <Link
                href="/register"
                onClick={e => { e.preventDefault(); setMode("register"); setError(""); }}
                className={`rounded-[50px] py-2.5 text-center text-xs font-extrabold transition ${
                  mode === "register"
                    ? "bg-[#049DFD] text-white shadow-sm"
                    : "text-[#404040] hover:text-black"
                }`}
              >
                Criar Conta
              </Link>
            </div>

            <div className="mb-6 text-center">
              <h2 className="text-[24px] font-black text-black">
                {mode === "login" ? "Bem-vindo ao Nexo" : "Crie sua Conta Nexo"}
              </h2>
              <p className="mt-1 text-[13px] text-[#7B7B7B]">
                {mode === "login"
                  ? "Acesse com sua conta Google ou e-mail corporativo."
                  : "Cadastre-se para automatizar suas cotações com IA."}
              </p>
            </div>

            {/* Google OAuth Pill Button */}
            <button
              type="button"
              onClick={() => void handleGoogleClick()}
              disabled={busy || googleBusy}
              className="flex w-full items-center justify-center gap-3 rounded-[50px] border-2 border-[#019EFD] bg-white px-5 py-3 text-sm font-extrabold text-[#049DFD] shadow-sm transition-all duration-200 hover:scale-[1.02] hover:bg-[#019EFD]/5 disabled:opacity-50"
            >
              {googleBusy ? <LoaderCircle size={18} className="animate-spin text-[#049DFD]" /> : <GoogleIcon />}
              <span>Continuar com o Google</span>
            </button>

            <div className="my-5 flex items-center gap-3">
              <div className="h-px flex-1 bg-[#ddd]" />
              <span className="text-[11px] font-semibold uppercase tracking-wider text-[#7B7B7B]">
                ou com e-mail corporativo
              </span>
              <div className="h-px flex-1 bg-[#ddd]" />
            </div>

            {error && (
              <div role="alert" className="mb-4 flex items-start gap-2.5 rounded-[14px] border border-rose-200 bg-rose-50 p-3.5 text-xs font-medium text-rose-700">
                <AlertCircle size={16} className="mt-0.5 shrink-0 text-rose-600" />
                <span>{error}</span>
              </div>
            )}

            <form onSubmit={e => void handleSubmit(e)} className="space-y-4">
              {mode === "register" && (
                <div>
                  <label className="mb-1.5 block text-xs font-bold text-[#2B2B2B]" htmlFor="auth-name">
                    Nome completo
                  </label>
                  <div className="relative">
                    <User size={16} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[#019EFD]" />
                    <input
                      id="auth-name"
                      type="text"
                      required
                      minLength={2}
                      maxLength={120}
                      value={name}
                      onChange={e => setName(e.target.value)}
                      placeholder="Ex.: Ana Ribeiro"
                      className="w-full rounded-[14px] border border-[#ddd] bg-[#F8FAFC] py-3 pl-11 pr-4 text-sm text-black placeholder-[#7B7B7B] outline-none transition focus:border-[#019EFD] focus:bg-white"
                    />
                  </div>
                </div>
              )}

              <div>
                <label className="mb-1.5 block text-xs font-bold text-[#2B2B2B]" htmlFor="auth-email">
                  E-mail corporativo
                </label>
                <div className="relative">
                  <Mail size={16} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[#019EFD]" />
                  <input
                    id="auth-email"
                    type="email"
                    required
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    placeholder="voce@empresa.com.br"
                    className="w-full rounded-[14px] border border-[#ddd] bg-[#F8FAFC] py-3 pl-11 pr-4 text-sm text-black placeholder-[#7B7B7B] outline-none transition focus:border-[#019EFD] focus:bg-white"
                  />
                </div>
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-bold text-[#2B2B2B]" htmlFor="auth-password">
                  Senha
                </label>
                <div className="relative">
                  <Lock size={16} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[#019EFD]" />
                  <input
                    id="auth-password"
                    type={showPassword ? "text" : "password"}
                    required
                    minLength={6}
                    maxLength={128}
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder="Mínimo de 6 caracteres"
                    className="w-full rounded-[14px] border border-[#ddd] bg-[#F8FAFC] py-3 pl-11 pr-11 text-sm text-black placeholder-[#7B7B7B] outline-none transition focus:border-[#019EFD] focus:bg-white"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(v => !v)}
                    aria-label={showPassword ? "Ocultar senha" : "Mostrar senha"}
                    className="absolute right-3.5 top-1/2 -translate-y-1/2 text-[#7B7B7B] hover:text-black"
                  >
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>

                {mode === "register" && password.length > 0 && (
                  <div className="mt-2 flex items-center gap-2">
                    <div className="flex flex-1 gap-1">
                      <span className={`h-1.5 flex-1 rounded-full ${passwordStrength >= 1 ? "bg-amber-400" : "bg-[#E9E9E9]"}`} />
                      <span className={`h-1.5 flex-1 rounded-full ${passwordStrength >= 2 ? "bg-[#019EFD]" : "bg-[#E9E9E9]"}`} />
                      <span className={`h-1.5 flex-1 rounded-full ${passwordStrength >= 3 ? "bg-[#415AFF]" : "bg-[#E9E9E9]"}`} />
                    </div>
                    <span className="text-[10px] font-bold text-[#7B7B7B]">
                      {passwordStrength === 1 ? "Fraca" : passwordStrength === 2 ? "Boa" : "Forte"}
                    </span>
                  </div>
                )}
              </div>

              {/* Pill Submit Button */}
              <button
                type="submit"
                disabled={busy || googleBusy}
                className="mt-3 flex w-full items-center justify-center gap-2 rounded-[50px] bg-[#049DFD] px-8 py-4 text-[16px] font-extrabold text-white shadow-lg shadow-[#049DFD]/30 transition-all duration-200 hover:scale-[1.02] hover:bg-[#35A6DF] disabled:opacity-50"
              >
                {busy ? (
                  <>
                    <LoaderCircle size={18} className="animate-spin" />
                    <span>{mode === "login" ? "Entrando…" : "Criando conta…"}</span>
                  </>
                ) : (
                  <>
                    <span>{mode === "login" ? "Acessar Plataforma Nexo" : "Criar Conta e Automatizar"}</span>
                    <ArrowRight size={17} />
                  </>
                )}
              </button>
            </form>

            <p className="mt-6 text-center text-xs text-[#404040]">
              {mode === "login" ? (
                <>
                  Ainda não possui conta?{" "}
                  <Link
                    href="/register"
                    onClick={e => { e.preventDefault(); setMode("register"); setError(""); }}
                    className="font-extrabold text-[#049DFD] hover:underline"
                  >
                    Cadastre-se gratuitamente
                  </Link>
                </>
              ) : (
                <>
                  Já possui uma conta?{" "}
                  <Link
                    href="/login"
                    onClick={e => { e.preventDefault(); setMode("login"); setError(""); }}
                    className="font-extrabold text-[#049DFD] hover:underline"
                  >
                    Fazer login
                  </Link>
                </>
              )}
            </p>
          </div>
        </div>
      </main>

      {/* Footer Strip (#101827) */}
      <footer className="relative z-10 bg-[#101827] py-4 text-center text-xs text-slate-300">
        ©2026 Nexo · Inteligência de Compras. Todos os direitos reservados.
      </footer>
    </div>
  );
}
