# Operating Leveret Inspect

An installation is one directory and one process. Running `bin/leveret-inspect` loads settings,
prepares the runtime directories, configures logging, and reports the configuration it resolved.

## Directory layout

| Directory | Property | Purpose |
|---|---|---|
| `conf/` | — | `leveret.properties`, the configuration file |
| `data/` | `leveret.path.data` | durable data; created when absent and never cleared by startup |
| `logs/` | `leveret.path.logs` | `leveret.log` |
| `temp/` | `leveret.path.temp` | runtime scratch; cleaned at startup, so it must not hold anything you need to keep |

The installation home is derived from the location of the application artifact. A configured value
for the home property is ignored. A relative value for any other directory resolves against the
home and is converted to an absolute path. A configured path that exists as a file, or a directory
that cannot be created, stops startup.

## Configuration precedence

For a recognized key, later sources override earlier ones:

1. `conf/leveret.properties`, read as UTF-8;
2. environment variables, named by uppercasing the key and replacing dots with underscores;
3. application arguments in `-Dkey=value` form;
4. JVM system properties;
5. built-in defaults, applied only to keys still unset.

A missing configuration file is a warning, not an error. An unreadable file, a malformed application
argument, or an unsupported log level stops startup with a nonzero exit status and the reason on
standard error. Nothing degrades to a default in silence.

## Storage

Everything durable lives in one embedded relational file under the data directory. The persistence
module owns that file and the keys that address it.

## Logging

All output goes to `logs/leveret.log`. `leveret.log.level` accepts `INFO`, `DEBUG` and `TRACE`.

Plain output is one line per event: timestamp, severity, name, thread, shortened logger name, and
message, with a throwable following its message as an indented stack trace. Setting
`leveret.log.jsonOutput` to true emits one JSON record per event instead, which is the form to
prefer whenever a tool rather than a person reads the log. Setting `leveret.log.console` to true
writes the same records to standard output as well as to the file.

Rotation is not performed: the file grows until something outside the engine archives or truncates
it.

## Security

The installation home, the configuration file, the data directory, and the log directory are trusted
local resources. Write access to any of them is control over what the engine reads and what it
reports, so restrict their ownership and permissions to the account that runs the engine.

The engine analyzes what that account can already read and grants no access the account does not
already have. Raising log verbosity surfaces configured values and analyzed source into the log
directory, which is the one thing routine verbosity changes can leak; treat that directory as
privileged for the same reason as the data directory.
