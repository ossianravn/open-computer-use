# A deterministic WinForms window for exercising open-computer-use end to end.
# Run: pwsh -NoProfile -File fixtures/windows/fixture.ps1 [-Title "OCU Fixture"]
param([string]$Title = "OCU Fixture", [switch]$Maximized)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object System.Windows.Forms.Form
$form.Text = $Title
$form.Size = New-Object System.Drawing.Size(560, 460)
$form.StartPosition = "CenterScreen"
if ($Maximized) { $form.WindowState = "Maximized" }

function Add-Control($control, $x, $y, $w, $h) {
    $control.Location = New-Object System.Drawing.Point($x, $y)
    $control.Size = New-Object System.Drawing.Size($w, $h)
    $form.Controls.Add($control)
    $control
}

$nameLabel = Add-Control (New-Object System.Windows.Forms.Label) 20 20 120 24
$nameLabel.Text = "Full name"
$name = Add-Control (New-Object System.Windows.Forms.TextBox) 150 18 360 24
$name.Name = "fullName"
$name.AccessibleName = "Full name"

$emailLabel = Add-Control (New-Object System.Windows.Forms.Label) 20 56 120 24
$emailLabel.Text = "Email"
$email = Add-Control (New-Object System.Windows.Forms.TextBox) 150 54 360 24
$email.Name = "email"
$email.AccessibleName = "Email address"

$subscribe = Add-Control (New-Object System.Windows.Forms.CheckBox) 150 90 200 24
$subscribe.Text = "Subscribe to newsletter"
$subscribe.Name = "subscribe"

$planLabel = Add-Control (New-Object System.Windows.Forms.Label) 20 126 120 24
$planLabel.Text = "Plan"
$plan = Add-Control (New-Object System.Windows.Forms.ComboBox) 150 124 200 24
$plan.Name = "plan"
$plan.AccessibleName = "Plan"
$plan.DropDownStyle = "DropDownList"
[void]$plan.Items.AddRange(@("Free", "Pro", "Team"))
$plan.SelectedIndex = 0

$colors = Add-Control (New-Object System.Windows.Forms.ListBox) 150 160 200 80
$colors.Name = "colors"
$colors.AccessibleName = "Favourite colour"
[void]$colors.Items.AddRange(@("Red", "Green", "Blue", "Yellow"))

$notes = Add-Control (New-Object System.Windows.Forms.TextBox) 150 250 360 60
$notes.Multiline = $true
$notes.Name = "notes"
$notes.AccessibleName = "Notes"

$status = Add-Control (New-Object System.Windows.Forms.Label) 20 380 500 24
$status.Name = "status"
$status.Text = "Status: ready"

$save = Add-Control (New-Object System.Windows.Forms.Button) 150 324 110 32
$save.Text = "Save draft"
$save.Add_Click({ $status.Text = "Status: draft saved" })

$submit = Add-Control (New-Object System.Windows.Forms.Button) 270 324 110 32
$submit.Text = "Submit"
$submit.Add_Click({
    $choice = if ($colors.SelectedItem) { $colors.SelectedItem } else { "none" }
    $status.Text = "Status: submitted $($name.Text) <$($email.Text)> plan=$($plan.SelectedItem) colour=$choice subscribed=$($subscribe.Checked)"
})

$delete = Add-Control (New-Object System.Windows.Forms.Button) 390 324 120 32
$delete.Text = "Delete all data"
$delete.Add_Click({ $status.Text = "Status: everything deleted" })

[void]$form.ShowDialog()
