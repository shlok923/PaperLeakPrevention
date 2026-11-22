interface KitModules {
    motion: { refresh(): void };
    moments: { mount(el: Element): Promise<{ destroy?: () => void } | null> };
}

interface Window {
    kit?: Promise<KitModules>;
}
