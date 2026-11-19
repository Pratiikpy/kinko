import { Seal } from "../components/Logo.tsx";
import { ButtonLink } from "../components/ui.tsx";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-lg py-16 text-center">
      <Seal size={56} className="mx-auto opacity-80" />
      <h1 className="mt-6 font-display text-3xl text-ink">There is nothing at this address.</h1>
      <p className="mt-3 text-ink-2">The link may be mistyped, or the page has moved.</p>
      <div className="mt-6 flex justify-center gap-3">
        <ButtonLink to="/">Go to the start</ButtonLink>
        <ButtonLink to="/app" variant="secondary">
          Open your account
        </ButtonLink>
      </div>
    </div>
  );
}
