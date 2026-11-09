# 只生成自撰合成語音；使用本機聲音，不連網，也不讀私人資料。
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$repo = Split-Path -Parent $PSScriptRoot
$output = Join-Path (Join-Path (Join-Path $repo '.tmp') 'audio-indexing-acceptance') 'tts'
New-Item -ItemType Directory -Path $output -Force | Out-Null
$format = [System.Speech.AudioFormat.SpeechAudioFormatInfo]::new(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$cases = @(
    @{ File = 'f01.wav'; Voice = 'Microsoft Hanhan Desktop'; Text = '把番茄切塊，加入雞蛋，最後加鹽調味。' },
    @{ File = 'f02.wav'; Voice = 'Microsoft David Desktop'; Text = 'The design review meeting starts at nine tomorrow morning. Please bring the project drawings.' },
    @{ File = 'f03.wav'; Voice = 'Microsoft Hanhan Desktop'; Text = '火車將在下午三點到達第二月台，請旅客準備上車。' },
    @{ File = 'tail.wav'; Voice = 'Microsoft Hanhan Desktop'; Text = '番茄炒蛋，加鹽調味。' }
)
foreach ($case in $cases) {
    $synth = [System.Speech.Synthesis.SpeechSynthesizer]::new()
    try {
        $synth.SelectVoice($case.Voice)
        $synth.SetOutputToWaveFile((Join-Path $output $case.File), $format)
        $synth.Speak($case.Text)
    } finally {
        $synth.Dispose()
    }
}
Write-Output '已生成四份本機合成語音 WAV。'
