# 只生成自撰合成語音；使用本機已安裝聲音，不連網、不讀私人資料。
# 產物：.tmp/video-a/corpus/tts/t01.wav ... t08.wav（16 kHz PCM16 mono）。
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$runId = $env:VIDEO_CORPUS_RUN_ID
if (-not $runId -or $runId -notmatch '^[a-zA-Z0-9_-]+$') { throw '必須設定有效 VIDEO_CORPUS_RUN_ID' }
$repo = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$corpus = Join-Path $repo (Join-Path '.tmp' (Join-Path 'video-acceptance' (Join-Path 'corpus' $runId)))
if (Test-Path -LiteralPath $corpus) { throw 'runId 已存在，請選用新的 runId' }
$output = Join-Path $corpus 'tts'
New-Item -ItemType Directory -Path $output -Force | Out-Null
$format = [System.Speech.AudioFormat.SpeechAudioFormatInfo]::new(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$cases = @(
    @{ File = 't01.wav'; Voice = 'Microsoft Hanhan Desktop'; Text = '把番茄切塊，加入雞蛋，最後加鹽調味。' },
    @{ File = 't02.wav'; Voice = 'Microsoft Hanhan Desktop'; Text = '列車即將進站，請旅客站在黃線後方等候。' },
    @{ File = 't03.wav'; Voice = 'Microsoft Hanhan Desktop'; Text = '明天早上九點開設計審查會議，記得帶圖紙。' },
    @{ File = 't04.wav'; Voice = 'Microsoft Hanhan Desktop'; Text = '市場早上六點開始營業，非常熱鬧。' },
    @{ File = 't05.wav'; Voice = 'Microsoft David Desktop'; Text = 'The interview is scheduled for next Tuesday at the downtown office.' },
    @{ File = 't06.wav'; Voice = 'Microsoft David Desktop'; Text = 'The library is quiet in the afternoon.' },
    @{ File = 't07.wav'; Voice = 'Microsoft David Desktop'; Text = 'The concert starts at eight in the evening.' },
    @{ File = 't08.wav'; Voice = 'Microsoft David Desktop'; Text = 'The bakery sells fresh bread every morning.' }
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
Get-ChildItem $output -Filter *.wav | ForEach-Object { "$($_.Name) $($_.Length)" }
