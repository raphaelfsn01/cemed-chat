"use client";
import { AlertsBell } from "./AlertsBell";
import { TenantSwitcher } from "./TenantSwitcher";
import { UserMenu } from "./UserMenu";
import { SearchTrigger } from "./SearchTrigger";
import { MenuGaveta } from "./MenuGaveta";
import { NavegacaoPrincipal } from "./Sidebar";

export function TopBar() {
  return (
    <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-2 border-b bg-background/95 px-4 backdrop-blur sm:gap-4 lg:px-6">
      <div className="flex min-w-0 items-center gap-2">
        <MenuGaveta>
          {(fechar) => <NavegacaoPrincipal collapsed={false} naGaveta aoNavegar={fechar} />}
        </MenuGaveta>
        <TenantSwitcher />
      </div>
      <div className="flex flex-1 justify-center md:max-w-md">
        <SearchTrigger />
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <AlertsBell />
        <UserMenu />
      </div>
    </header>
  );
}
