"use client";

import { Button } from "@solyn/ui/components/button";
import { FolderClosed, House, Menu, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import SignOutButton from "./sign-out-button";

export function Wordmark() {
  return (
    <span className="wordmark" translate="no">
      solyn<span>.</span>
    </span>
  );
}

export default function WorkspaceShell({
  name,
  email,
  children,
}: {
  name: string;
  email: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      toggle.current?.focus();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [open]);
  return (
    <div className="workspace-shell">
      <a className="skip-link" href="#workspace-main">
        Skip to content
      </a>
      <header className="mobile-header glass">
        <Link href="/dashboard" aria-label="Solyn workspace">
          <Wordmark />
        </Link>
        <Button
          ref={toggle}
          type="button"
          variant="ghost"
          className="control"
          aria-controls="workspace-sidebar"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}{" "}
          {open ? "Close menu" : "Menu"}
        </Button>
      </header>
      <aside id="workspace-sidebar" className={`sidebar glass ${open ? "is-open" : ""}`}>
        <Link
          className="sidebar-brand"
          href="/dashboard"
          aria-label="Solyn workspace"
          onClick={() => setOpen(false)}
        >
          <Wordmark />
        </Link>
        <p className="sidebar-caption">Personal workspace</p>
        <nav
          aria-label="Workspace"
          onClick={(event) => {
            if (event.target instanceof Element && event.target.closest("a")) setOpen(false);
          }}
        >
          <Link
            className="nav-item"
            href="/dashboard"
            aria-current={pathname === "/dashboard" ? "page" : undefined}
          >
            <House size={17} aria-hidden="true" />
            Workspace
          </Link>
          <Link
            className="nav-item"
            href="/projects"
            aria-current={pathname.startsWith("/projects") ? "page" : undefined}
          >
            <FolderClosed size={17} aria-hidden="true" />
            Projects
          </Link>
        </nav>
        <div className="sidebar-bottom">
          <div className="account">
            <span className="avatar" aria-hidden="true">
              {name.trim().slice(0, 1).toUpperCase() || "S"}
            </span>
            <div>
              <p>{name || "Your account"}</p>
              <span>{email}</span>
            </div>
          </div>
          <SignOutButton />
        </div>
      </aside>
      <main id="workspace-main" className="workspace-main" tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}
