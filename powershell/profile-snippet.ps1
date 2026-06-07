# Windows PowerShell profile (auto-loaded)
# ----------------------------------------------------------------------
# cloop - Claude auto-reconnect loop (skip-permissions mode)
# Usage: in your project folder, just type:  cloop
#   - exit a session         : type  /exit  inside the session   (Ctrl+D alternative)
#   - stop loop (no reconnect): press  q  within 5s after exit    (Ctrl+C alternative)
#   - do nothing             : auto-reconnect a new session after 5s
function cloop {
    Write-Host "=== Claude auto-reconnect loop (cloop) ===" -ForegroundColor Cyan
    Write-Host "Folder: $(Get-Location)" -ForegroundColor DarkGray
    Write-Host "Exit a session : type  /exit  inside the session" -ForegroundColor DarkGray
    Write-Host "Stop the loop  : press  q  within 5s after a session ends" -ForegroundColor DarkGray
    Write-Host ""
    while ($true) {
        claude --dangerously-skip-permissions

        Write-Host ""
        Write-Host "Session ended. Auto-reconnect in 5s... (press 'q' now to quit completely)" -ForegroundColor Yellow

        try { $Host.UI.RawUI.FlushInputBuffer() } catch {}
        $deadline = (Get-Date).AddSeconds(5)
        $quit = $false
        while ((Get-Date) -lt $deadline) {
            if ([Console]::KeyAvailable) {
                $k = [Console]::ReadKey($true)
                if ($k.KeyChar -eq 'q' -or $k.KeyChar -eq 'Q') { $quit = $true }
                break
            }
            Start-Sleep -Milliseconds 100
        }
        if ($quit) { Write-Host "cloop stopped." -ForegroundColor Cyan; break }
        Write-Host "--- reconnecting ---" -ForegroundColor Cyan
    }
}
