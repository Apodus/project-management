import { Link, useMatches } from "@tanstack/react-router";
import { cn } from "@/lib/utils";

const settingsLinks = [
  { label: "Users", href: "/settings/users" },
  { label: "Templates", href: "/settings/templates" },
  { label: "Backup", href: "/settings/backup" },
];

export function SettingsNav() {
  const matches = useMatches();
  const currentPath = matches[matches.length - 1]?.fullPath ?? "";

  return (
    <nav className="flex gap-1 border-b pb-3">
      {settingsLinks.map((link) => {
        const isActive = currentPath.includes(link.href);
        return (
          <Link
            key={link.href}
            to={link.href}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              isActive
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
