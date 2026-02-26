package com.example.smartgoprototype.ui.addroute

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.example.smartgoprototype.domain.model.PlaceLocation
import java.time.DayOfWeek
import java.time.format.TextStyle
import java.util.Locale

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AddRouteScreen(
    uiState: AddRouteUiState,
    onBack: () -> Unit,
    onTitleChange: (String) -> Unit,
    onOriginSelected: (PlaceLocation) -> Unit,
    onDestinationSelected: (PlaceLocation) -> Unit,
    onArriveByChange: (hour: Int, minute: Int) -> Unit,
    onToggleDay: (DayOfWeek) -> Unit,
    onSave: () -> Unit
) {
    val context = LocalContext.current
    val snackbarHostState = remember { SnackbarHostState() }
    var showTimePicker by remember { mutableStateOf(false) }

    // Local error channel for picker errors so it can be compiled without ViewModel hooks
    var localError by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(uiState.errorMessage) {
        uiState.errorMessage?.let { snackbarHostState.showSnackbar(it) }
    }

    LaunchedEffect(localError) {
        localError?.let {
            snackbarHostState.showSnackbar(it)
            localError = null
        }
    }

    val originPicker = rememberPlaceAutocompleteLauncher(
        context = context,
        onSelected = onOriginSelected,
        onError = { localError = it }
    )

    val destinationPicker = rememberPlaceAutocompleteLauncher(
        context = context,
        onSelected = onDestinationSelected,
        onError = { localError = it }
    )

    Scaffold(
        topBar = {
            CenterAlignedTopAppBar(
                title = { Text("Add route") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                }
            )
        },
        snackbarHost = { SnackbarHost(snackbarHostState) },
        bottomBar = {
            Surface(tonalElevation = 2.dp) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(16.dp),
                    horizontalArrangement = Arrangement.End
                ) {
                    Button(onClick = onSave, enabled = uiState.canSave) {
                        if (uiState.isSaving) {
                            CircularProgressIndicator(strokeWidth = 2.dp)
                        } else {
                            Text("Save")
                        }
                    }
                }
            }
        }
    ) { inner ->
        Column(
            modifier = Modifier
                .padding(inner)
                .padding(16.dp)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            OutlinedTextField(
                value = uiState.title,
                onValueChange = onTitleChange,
                label = { Text("Route title") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true
            )

            PlaceField(
                label = "Origin",
                value = uiState.origin?.address ?: uiState.origin?.name,
                onPick = originPicker
            )

            PlaceField(
                label = "Destination",
                value = uiState.destination?.address ?: uiState.destination?.name,
                onPick = destinationPicker
            )

            OutlinedTextField(
                value = "%02d:%02d".format(uiState.arriveBy.hour, uiState.arriveBy.minute),
                onValueChange = {},
                readOnly = true,
                label = { Text("Arrive by") },
                modifier = Modifier.fillMaxWidth(),
                supportingText = {
                    Text("Stored as minutes since midnight + timezone for backend.")
                }
            )
            TextButton(onClick = { showTimePicker = true }) { Text("Change time") }

            DaysOfWeekChips(selected = uiState.activeDays, onToggle = onToggleDay)
        }
    }

    if (showTimePicker) {
        ArriveByTimePickerDialog(
            initialHour = uiState.arriveBy.hour,
            initialMinute = uiState.arriveBy.minute,
            onDismiss = { showTimePicker = false },
            onConfirm = { h, m ->
                onArriveByChange(h, m)
                showTimePicker = false
            }
        )
    }
}

@Composable
private fun PlaceField(
    label: String,
    value: String?,
    onPick: () -> Unit
) {
    Column(Modifier.fillMaxWidth()) {
        Text(label, style = MaterialTheme.typography.labelLarge)
        Spacer(Modifier.height(6.dp))
        Surface(shape = MaterialTheme.shapes.medium, tonalElevation = 1.dp) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(14.dp),
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Text(value ?: "Tap to select", style = MaterialTheme.typography.bodyLarge)
                TextButton(onClick = onPick) { Text("Pick") }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ArriveByTimePickerDialog(
    initialHour: Int,
    initialMinute: Int,
    onDismiss: () -> Unit,
    onConfirm: (hour: Int, minute: Int) -> Unit
) {
    val state = rememberTimePickerState(
        initialHour = initialHour,
        initialMinute = initialMinute,
        is24Hour = true
    )

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Select arrive-by time") },
        text = { TimePicker(state = state) },
        confirmButton = {
            TextButton(onClick = { onConfirm(state.hour, state.minute) }) { Text("OK") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Cancel") }
        }
    )
}

@Composable
private fun DaysOfWeekChips(
    selected: Set<DayOfWeek>,
    onToggle: (DayOfWeek) -> Unit
) {
    Column(Modifier.fillMaxWidth()) {
        Text("Active days", style = MaterialTheme.typography.labelLarge)
        Spacer(Modifier.height(8.dp))
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            DayOfWeek.values().forEach { day ->
                FilterChip(
                    selected = selected.contains(day),
                    onClick = { onToggle(day) },
                    label = { Text(day.getDisplayName(TextStyle.SHORT, Locale.getDefault())) }
                )
            }
        }
    }
}