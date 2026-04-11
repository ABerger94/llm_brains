export default function PageShell({ icon: Icon, title, description, actions, maxWidth = 'max-w-7xl', children }) {
  return (
    <div className="min-h-screen p-4 sm:p-6">
      <div className={`mx-auto ${maxWidth}`}>
        <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0">
            <div className="mb-2 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/15">
                <Icon className="h-5 w-5 text-primary" />
              </div>
              <h1 className="text-2xl font-bold">{title}</h1>
            </div>
            {description ? (
              <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>
            ) : null}
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
        {children}
      </div>
    </div>
  );
}
