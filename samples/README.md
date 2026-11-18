# Sample data only

Everything under `samples/` is **fictional, illustrative data**. It is never
loaded by the plugin at runtime. The real data directory is:

```text
~/.dsh/bionic-soul/
```

These files exist so a developer can see the expected shape of the identity,
scratchpad, catalog, journal and dream files without reading or copying a real
user's soul.

To try them:

```powershell
$tmp = Join-Path $env:TEMP "bionic-sample-soul"
Copy-Item -Recurse "samples/bionic-soul" $tmp
```

Then set a private test config with an absolute `dataDir` pointing at `$tmp`.
Do not point `dataDir` at `~/.dsh/bionic-soul` while experimenting.

The sample names ("示例名字", "示例称呼") are placeholders, not a preset role.
