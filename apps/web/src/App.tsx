import { lazy, type ReactNode, Suspense, useEffect } from "react";
import { Route, Routes, useLocation } from "react-router-dom";

import { AppLayout, Footer, SiteHeader } from "./components/Shell.tsx";
import { Skeleton } from "./components/ui.tsx";

// Every page is its own chunk: the landing page and the public backing page
// never download the contract runtime or its WebAssembly.
const Landing = lazy(() => import("./pages/Landing.tsx"));
const Backing = lazy(() => import("./pages/Backing.tsx"));
const Examine = lazy(() => import("./pages/Examine.tsx"));
const Checkout = lazy(() => import("./pages/Checkout.tsx"));
const HeldCard = lazy(() => import("./pages/HeldCard.tsx"));
const Verify = lazy(() => import("./pages/Verify.tsx"));
const Docs = lazy(() => import("./pages/Docs.tsx"));
const Developer = lazy(() => import("./pages/Developer.tsx"));
const Vision = lazy(() => import("./pages/Vision.tsx"));
const Privacy = lazy(() => import("./pages/Privacy.tsx"));
const Walkthrough = lazy(() => import("./pages/Walkthrough.tsx"));
const NotFound = lazy(() => import("./pages/NotFound.tsx"));

const Home = lazy(() => import("./pages/app/Home.tsx"));
const Add = lazy(() => import("./pages/app/Add.tsx"));
const Withdraw = lazy(() => import("./pages/app/Withdraw.tsx"));
const Pay = lazy(() => import("./pages/app/Pay.tsx"));
const Request = lazy(() => import("./pages/app/Request.tsx"));
const Invoices = lazy(() => import("./pages/app/Invoices.tsx"));
const InvoiceDetail = lazy(() => import("./pages/app/InvoiceDetail.tsx"));
const Batch = lazy(() => import("./pages/app/Batch.tsx"));
const Gifts = lazy(() => import("./pages/app/Gifts.tsx"));
const Card = lazy(() => import("./pages/app/Card.tsx"));
const Receipts = lazy(() => import("./pages/app/Receipts.tsx"));
const Merchant = lazy(() => import("./pages/app/Merchant.tsx"));
const Tags = lazy(() => import("./pages/app/Tags.tsx"));
const Settings = lazy(() => import("./pages/app/Settings.tsx"));

function Loading() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-8 w-56" />
      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    </div>
  );
}

function Page({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className={wide ? "" : "mx-auto w-full max-w-6xl px-4 pb-16 pt-8 sm:px-6"}>{children}</div>
  );
}

const TITLES: [RegExp, string][] = [
  [/^\/$/, "Kinko · a private dollar account"],
  [/^\/backing/, "Backing · Kinko"],
  [/^\/examine/, "Examine · Kinko"],
  [/^\/checkout/, "Checkout · Kinko"],
  [/^\/gift/, "A gift card · Kinko"],
  [/^\/card/, "A Kinko card · Kinko"],
  [/^\/verify/, "Verify a receipt · Kinko"],
  [/^\/docs/, "Docs · Kinko"],
  [/^\/developer/, "Developers · Kinko"],
  [/^\/vision/, "Vision · Kinko"],
  [/^\/privacy/, "Privacy and limits · Kinko"],
  [/^\/walkthrough/, "Guided tour · Kinko"],
  [/^\/app\/add/, "Add dollars · Kinko"],
  [/^\/app\/withdraw/, "Withdraw · Kinko"],
  [/^\/app\/pay|^\/pay/, "Pay · Kinko"],
  [/^\/app\/request/, "Request · Kinko"],
  [/^\/app\/invoices/, "Invoices · Kinko"],
  [/^\/app\/batch/, "Batch pay · Kinko"],
  [/^\/app\/gifts/, "Gift cards · Kinko"],
  [/^\/app\/card/, "PIN card · Kinko"],
  [/^\/app\/receipts/, "Receipts · Kinko"],
  [/^\/app\/merchant/, "Merchant · Kinko"],
  [/^\/app\/tags/, "Your @tag · Kinko"],
  [/^\/app\/settings/, "Settings · Kinko"],
  [/^\/app/, "Account · Kinko"],
];

function useTitleAndScroll() {
  const { pathname } = useLocation();
  useEffect(() => {
    document.title = TITLES.find(([re]) => re.test(pathname))?.[1] ?? "Kinko";
    window.scrollTo(0, 0);
  }, [pathname]);
}

export function App() {
  useTitleAndScroll();
  const app = (el: ReactNode) => <AppLayout>{el}</AppLayout>;
  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />
      <main id="main" className="flex-1">
        <Suspense fallback={<Loading />}>
          <Routes>
            <Route
              path="/"
              element={
                <Page wide>
                  <Landing />
                </Page>
              }
            />
            <Route
              path="/backing"
              element={
                <Page>
                  <Backing />
                </Page>
              }
            />
            <Route
              path="/examine"
              element={
                <Page>
                  <Examine />
                </Page>
              }
            />
            <Route
              path="/checkout"
              element={
                <Page>
                  <Checkout />
                </Page>
              }
            />
            {["/gift", "/card"].map((path) => (
              <Route
                key={path}
                path={path}
                element={
                  <Page>
                    <HeldCard />
                  </Page>
                }
              />
            ))}
            <Route
              path="/verify"
              element={
                <Page>
                  <Verify />
                </Page>
              }
            />
            <Route
              path="/docs"
              element={
                <Page>
                  <Docs />
                </Page>
              }
            />
            <Route
              path="/developer"
              element={
                <Page>
                  <Developer />
                </Page>
              }
            />
            <Route
              path="/vision"
              element={
                <Page>
                  <Vision />
                </Page>
              }
            />
            <Route
              path="/privacy"
              element={
                <Page>
                  <Privacy />
                </Page>
              }
            />
            <Route
              path="/walkthrough"
              element={
                <Page>
                  <Walkthrough />
                </Page>
              }
            />
            <Route path="/pay" element={app(<Pay />)} />
            <Route path="/app" element={app(<Home />)} />
            <Route path="/app/add" element={app(<Add />)} />
            <Route path="/app/withdraw" element={app(<Withdraw />)} />
            <Route path="/app/pay" element={app(<Pay />)} />
            <Route path="/app/request" element={app(<Request />)} />
            <Route path="/app/invoices" element={app(<Invoices />)} />
            <Route path="/app/invoices/:commitment" element={app(<InvoiceDetail />)} />
            <Route path="/app/batch" element={app(<Batch />)} />
            <Route path="/app/gifts" element={app(<Gifts />)} />
            <Route path="/app/card" element={app(<Card />)} />
            <Route path="/app/receipts" element={app(<Receipts />)} />
            <Route path="/app/merchant" element={app(<Merchant />)} />
            <Route path="/app/tags" element={app(<Tags />)} />
            <Route path="/app/settings" element={app(<Settings />)} />
            <Route
              path="*"
              element={
                <Page>
                  <NotFound />
                </Page>
              }
            />
          </Routes>
        </Suspense>
      </main>
      <Footer />
    </div>
  );
}
