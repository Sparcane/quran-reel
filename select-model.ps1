param(
    [ValidateSet("architecture","coding","simple","vision","deep","fast","finegrained","thinking","premium","research","fallback","geminipremium","geminibalanced","geminicheap","geminithinking","geminiresearch")]
    [string]$TaskType = "coding",
    [switch]$Copy
)

$map = @{
    "architecture"      = @{ model = "opencode/beam-free"; variant = "high" }
    "coding"            = @{ model = "opencode/deepseek-v4.1-flash-free"; variant = "high" }
    "simple"            = @{ model = "opencode/deepseek-v4.1-flash-free"; variant = "low" }
    "vision"            = @{ model = "opencode/nemotron-3.5-super-vl-free"; variant = "high" }
    "deep"              = @{ model = "opencode/beam-free"; variant = "max" }
    "fast"              = @{ model = "opencode/mimo-v2.6-flash-free"; variant = "" }
    "finegrained"       = @{ model = "opencode/inkling-2-small-free"; variant = "high" }
    "thinking"          = @{ model = "google/gemma-4-26b-a4b-it"; variant = "thinking" }
    "premium"           = @{ model = "opencode/beam-free"; variant = "max" }
    "research"          = @{ model = "google/deep-research-max-preview-04-2026"; variant = "" }
    "fallback"          = @{ model = "opencode/big-pickle"; variant = "" }
    "geminipremium"     = @{ model = "google/gemini-4-hydrogen"; variant = "high" }
    "geminibalanced"    = @{ model = "google/gemini-3.8-flash"; variant = "high" }
    "geminicheap"       = @{ model = "google/gemini-flash-lite-latest"; variant = "high" }
    "geminithinking"    = @{ model = "google/gemma-4-26b-a4b-it"; variant = "thinking" }
    "geminiresearch"    = @{ model = "google/deep-research-max-preview-04-2026"; variant = "" }
}

$entry = $map[$TaskType]
$ref = if ($entry.variant) { "$($entry.model)#$($entry.variant)" } else { $entry.model }

Write-Host "Task type : $TaskType"
Write-Host "Model     : $($entry.model)"
if ($entry.variant) { Write-Host "Variant   : $($entry.variant)" }
Write-Host "Reference : $ref"

if ($Copy) {
    Set-Clipboard -Value $ref
    Write-Host "(copied to clipboard)"
}
