const SPEC = '# Greeter spec\n\nInserted by the greeter plugin at the close.\n';
export function offer() {
  return {
    title: 'Greeter: say hello',
    tags: ['demo'],
    spec_of: () => SPEC,
    why: 'greeter fires at every close',
    note: 'fixed offer from the greeter fixture plugin',
  };
}
