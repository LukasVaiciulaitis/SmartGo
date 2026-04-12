package com.example.smartgoprototype.ui.addroute

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material3.BasicAlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.TimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.example.smartgoprototype.domain.model.TravelMode
import java.time.DayOfWeek

private val DAY_LABELS = mapOf(
    DayOfWeek.MONDAY    to "M",
    DayOfWeek.TUESDAY   to "T",
    DayOfWeek.WEDNESDAY to "W",
    DayOfWeek.THURSDAY  to "T",
    DayOfWeek.FRIDAY    to "F",
    DayOfWeek.SATURDAY  to "S",
    DayOfWeek.SUNDAY    to "S"
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ArriveByTimeInput(state: TimePickerState) {
    var showPicker by remember { mutableStateOf(false) }

    Column(modifier = Modifier.fillMaxWidth()) {
        Text("Arrive by", style = MaterialTheme.typography.labelLarge)
        Spacer(Modifier.height(8.dp))
        Surface(
            onClick = { showPicker = true },
            modifier = Modifier.fillMaxWidth(),
            shape = MaterialTheme.shapes.medium,
            color = MaterialTheme.colorScheme.surfaceVariant
        ) {
            Row(
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 18.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(16.dp)
            ) {
                Icon(
                    imageVector = Icons.Default.Schedule,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.primary
                )
                Text(
                    text = "%02d:%02d".format(state.hour, state.minute),
                    style = MaterialTheme.typography.headlineLarge,
                    color = MaterialTheme.colorScheme.primary
                )
                Spacer(Modifier.weight(1f))
                Text(
                    text = "Tap to change",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }

    if (showPicker) {
        BasicAlertDialog(onDismissRequest = { showPicker = false }) {
            Surface(
                shape = MaterialTheme.shapes.extraLarge,
                color = MaterialTheme.colorScheme.surface
            ) {
                Column(
                    modifier = Modifier.padding(24.dp),
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    Text(
                        text = "Select arrival time",
                        style = MaterialTheme.typography.labelLarge,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(bottom = 20.dp)
                    )
                    TimePicker(state = state)
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.End
                    ) {
                        TextButton(onClick = { showPicker = false }) { Text("Cancel") }
                        TextButton(onClick = { showPicker = false }) { Text("OK") }
                    }
                }
            }
        }
    }
}

@Composable
internal fun TravelModePicker(
    selected: TravelMode,
    onSelected: (TravelMode) -> Unit
) {
    val modeLabels = mapOf(
        TravelMode.DRIVE       to "Drive",
        TravelMode.TRANSIT     to "Transit",
        TravelMode.WALK        to "Walk",
        TravelMode.TWO_WHEELER to "2W",
        TravelMode.BICYCLE     to "Bike"
    )

    Column(Modifier.fillMaxWidth()) {
        Text("Travel mode", style = MaterialTheme.typography.labelLarge)
        Spacer(Modifier.height(8.dp))
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            TravelMode.entries.forEach { mode ->
                FilterChip(
                    modifier = Modifier.weight(1f),
                    selected = selected == mode,
                    onClick = { onSelected(mode) },
                    label = {
                        Text(
                            text = modeLabels[mode] ?: mode.name.replace('_', ' '),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            style = MaterialTheme.typography.labelSmall
                        )
                    }
                )
            }
        }
    }
}

@Composable
internal fun DaysOfWeekChips(
    selected: Set<DayOfWeek>,
    onToggle: (DayOfWeek) -> Unit
) {
    Column(Modifier.fillMaxWidth()) {
        Text("Active days", style = MaterialTheme.typography.labelLarge)
        Spacer(Modifier.height(8.dp))
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            DayOfWeek.entries.forEach { day ->
                FilterChip(
                    modifier = Modifier.weight(1f),
                    selected = selected.contains(day),
                    onClick = { onToggle(day) },
                    label = {
                        Text(
                            text = DAY_LABELS[day] ?: day.name.first().toString(),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            style = MaterialTheme.typography.labelSmall,
                            textAlign = TextAlign.Center,
                            modifier = Modifier.fillMaxWidth()
                        )
                    }
                )
            }
        }
    }
}
