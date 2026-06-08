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
    # On reconnect, seed Claude with a first prompt so it recaps the restored handoff and asks what to do.
    $greeting = 'A previous-session handoff summary, wiki note, and index were just injected at SessionStart. In 2-3 lines, briefly recap what was done in the previous session and where things stand, then ask me what to work on next. Reply in the same language as that summary. If there is no prior record, just say so and ask what to do.'
    $reconnecting = $false
    while ($true) {
        if ($reconnecting) { claude --dangerously-skip-permissions $greeting } else { claude --dangerously-skip-permissions }

        Write-Host ""
        try { $Host.UI.RawUI.FlushInputBuffer() } catch {}
        $quit = $false

        # Wait for the background distillation (summary/wiki) to finish before reconnecting,
        # so the next session can actually read the just-ended session's handoff.
        # The SessionEnd hook creates sessions\.distilling; the worker removes it when done.
        $marker = Join-Path (Get-Location) 'sessions\.distilling'
        $active = $false
        if (Test-Path $marker) {
            try { $age = ((Get-Date) - (Get-Item $marker).LastWriteTime).TotalSeconds } catch { $age = 0 }
            if ($age -lt 180) { $active = $true }   # ignore a stale marker (dead worker)
        }
        if ($active) {
            Write-Host "Distilling previous session (summary/wiki)... waiting so the next session can read it. (press 'q' to quit)" -ForegroundColor DarkGray
            $dl = (Get-Date).AddSeconds(95)
            while ((Test-Path $marker) -and ((Get-Date) -lt $dl)) {
                if ([Console]::KeyAvailable) {
                    $k = [Console]::ReadKey($true)
                    if ($k.KeyChar -eq 'q' -or $k.KeyChar -eq 'Q') { $quit = $true }
                    break
                }
                Start-Sleep -Milliseconds 300
            }
        }

        if (-not $quit) {
            Write-Host "Auto-reconnect in 5s... (press 'q' now to quit completely)" -ForegroundColor Yellow
            $deadline = (Get-Date).AddSeconds(5)
            while ((Get-Date) -lt $deadline) {
                if ([Console]::KeyAvailable) {
                    $k = [Console]::ReadKey($true)
                    if ($k.KeyChar -eq 'q' -or $k.KeyChar -eq 'Q') { $quit = $true }
                    break
                }
                Start-Sleep -Milliseconds 100
            }
        }
        if ($quit) { Write-Host "cloop stopped." -ForegroundColor Cyan; break }
        $reconnecting = $true
        Write-Host "--- reconnecting ---" -ForegroundColor Cyan
    }
}
