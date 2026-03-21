package com.example.smartgoprototype.ui.addroute

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TimeInput
import androidx.compose.material3.TimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.example.smartgoprototype.domain.model.TravelMode
import java.time.DayOfWeek
import java.time.format.TextStyle
import java.util.Locale

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ArriveByTimeInput(state: TimePickerState) {
    Column(Modifier.fillMaxWidth()) {
        Text("Arrive by", style = MaterialTheme.typography.labelLarge)
        Spacer(Modifier.height(6.dp))
        TimeInput(state = state)
    }
}

@Composable
internal fun TravelModePicker(
    selected: TravelMode,
    onSelected: (TravelMode) -> Unit
) {
    val modeLabels = mapOf(
        TravelMode.DRIVE to "Drive",
        TravelMode.TRANSIT to "Transit",
        TravelMode.WALK to "Walk",
        TravelMode.TWO_WHEELER to "2W",
        TravelMode.BICYCLE to "Bike"
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
            modifier = Modifier.horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            DayOfWeek.entries.forEach { day ->
                FilterChip(
                    selected = selected.contains(day),
                    onClick = { onToggle(day) },
                    label = { Text(day.getDisplayName(TextStyle.SHORT, Locale.getDefault())) }
                )
            }
        }
    }
}
