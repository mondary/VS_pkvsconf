import * as vscode from "vscode";

export interface FeatureToggleDef {
  id: string;
  label: string;
  description: string;
}

export const FEATURE_TOGGLES: FeatureToggleDef[] = [
  { id: "revealInFinder", label: "Reveal in Finder", description: "Bouton de l'Explorer" },
  { id: "rootSize", label: "Taille du dossier racine", description: "Status bar" },
  { id: "explorerSizes", label: "Tailles dans l'Explorer", description: "Badges + vue détaillée" },
  { id: "projectIcon", label: "Project Icon", description: "Vue latérale" },
  { id: "githubRepo", label: "Open GitHub Repository", description: "Bouton Source Control" },
  { id: "extensionTags", label: "Tags d'extensions", description: "Vue latérale" },
  { id: "previewPage", label: "Preview page + Server", description: "Status bar + menus" },
  { id: "titlebarColor", label: "Couleur de la title bar", description: "Status bar" },
  { id: "secrets", label: "Secrets exposés + blocage commit", description: "Status bar + Source Control" },
  { id: "launchpad", label: "Launchpad projets", description: "Vue + boutons status bar" },
  { id: "sessions", label: "Sessions agents + historique", description: "Status bar + vue historique" },
  { id: "kanban", label: "Kanban TUI", description: "Boutons status bar" },
  { id: "skillsSymlink", label: "Agent Skills", description: "Status bar + bouton Explorer" },
  { id: "gitignoreMenu", label: "Ajouter au .gitignore", description: "Menu contextuel" },
  { id: "gitignoreDecorations", label: "Décorations gitignore", description: "Badges ⛔ dans l'Explorer" },
  { id: "notes", label: "Notes de projet", description: "Vue barre latérale droite" },
  { id: "termShortcuts", label: "Boutons Terminal", description: "Status bar" }
];

const STORAGE_KEY = "pkvsconf.featureToggles";

interface GuardedItem {
  wanted: boolean;
  show(): void;
  hide(): void;
}

let extensionContext: vscode.ExtensionContext | undefined;
const guardedItems = new Map<string, GuardedItem[]>();
const changeEmitter = new vscode.EventEmitter<string>();
export const onFeatureTogglesChanged = changeEmitter.event;

export function isFeatureEnabled(featureId: string): boolean {
  const state = extensionContext?.globalState.get<Record<string, boolean>>(STORAGE_KEY);
  return state?.[featureId] !== false;
}

export function guardStatusBarItem(
  item: vscode.StatusBarItem,
  featureId: string
): void {
  const guarded: GuardedItem = {
    wanted: false,
    show: item.show.bind(item),
    hide: item.hide.bind(item)
  };
  item.show = () => {
    guarded.wanted = true;
    if (isFeatureEnabled(featureId)) guarded.show();
    else guarded.hide();
  };
  item.hide = () => {
    guarded.wanted = false;
    guarded.hide();
  };
  const list = guardedItems.get(featureId) ?? [];
  list.push(guarded);
  guardedItems.set(featureId, list);
}

function applyFeatureVisibility(featureId: string): void {
  for (const guarded of guardedItems.get(featureId) ?? []) {
    if (isFeatureEnabled(featureId) && guarded.wanted) guarded.show();
    else guarded.hide();
  }
}

export async function setFeatureEnabled(
  featureId: string,
  enabled: boolean
): Promise<void> {
  if (!extensionContext) return;
  const state =
    extensionContext.globalState.get<Record<string, boolean>>(STORAGE_KEY) ?? {};
  state[featureId] = enabled;
  await extensionContext.globalState.update(STORAGE_KEY, state);
  await vscode.commands.executeCommand(
    "setContext",
    `pkvsconf.enable.${featureId}`,
    enabled
  );
  applyFeatureVisibility(featureId);
  changeEmitter.fire(featureId);
}

export async function initFeatureToggles(
  context: vscode.ExtensionContext
): Promise<void> {
  extensionContext = context;
  await Promise.all(
    FEATURE_TOGGLES.map((feature) =>
      vscode.commands.executeCommand(
        "setContext",
        `pkvsconf.enable.${feature.id}`,
        isFeatureEnabled(feature.id)
      )
    )
  );
}

export function registerFeatureTogglesCommand(
  context: vscode.ExtensionContext
): vscode.Disposable {
  return vscode.commands.registerCommand("pkvsconf.toggleFeatures", async () => {
    const pickLoop = async (): Promise<void> => {
      const items: Array<vscode.QuickPickItem & { featureId?: string; all?: boolean }> = [
        {
          label: "$(check-all) Tout activer",
          all: true,
          alwaysShow: true
        },
        { label: "Fonctionnalités", kind: vscode.QuickPickItemKind.Separator }
      ];
      for (const feature of FEATURE_TOGGLES) {
        const on = isFeatureEnabled(feature.id);
        items.push({
          label: `${on ? "$(check)" : "$(circle-slash)"} ${feature.label}`,
          description: on ? "activée" : "désactivée",
          detail: feature.description,
          featureId: feature.id
        });
      }
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: "Cliquer une fonctionnalité pour l'activer / désactiver (Échap pour fermer)"
      });
      if (!picked) return;
      if (picked.all) {
        await Promise.all(
          FEATURE_TOGGLES.map((feature) => setFeatureEnabled(feature.id, true))
        );
        await pickLoop();
        return;
      }
      if (picked.featureId) {
        await setFeatureEnabled(picked.featureId, !isFeatureEnabled(picked.featureId));
        await pickLoop();
      }
    };
    await pickLoop();
  });
}
