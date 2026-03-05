package com.example.smartgoprototype.ui.addroute

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Search
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
import androidx.compose.material3.TimeInput
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.text.input.ImeAction
import com.example.smartgoprototype.domain.model.PlaceLocation
import com.example.smartgoprototype.domain.model.TravelMode
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
    onTravelModeSelected: (TravelMode) -> Unit,
    onArriveByChange: (hour: Int, minute: Int) -> Unit,
    onToggleDay: (DayOfWeek) -> Unit,
    onSave: () -> Unit
) {
    val context = LocalContext.current
    val snackbarHostState = remember { SnackbarHostState() }

    // Local error channel for picker errors so it can be compiled without ViewModel hooks
    var localError by remember { mutableStateOf<String?>(null) }

    val arriveByState = rememberTimePickerState(
        initialHour = uiState.arriveBy.hour,
        initialMinute = uiState.arriveBy.minute,
        is24Hour = true
    )

    LaunchedEffect(uiState.errorMessage) {
        uiState.errorMessage?.let { snackbarHostState.showSnackbar(it) }
    }

    LaunchedEffect(localError) {
        localError?.let {
            snackbarHostState.showSnackbar(it)
            localError = null
        }
    }

    LaunchedEffect(arriveByState.hour, arriveByState.minute) {
        if (arriveByState.hour != uiState.arriveBy.hour || arriveByState.minute != uiState.arriveBy.minute) {
            onArriveByChange(arriveByState.hour, arriveByState.minute)
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
                value = uiState.origin?.label,
                placeholder = "Search origin",
                onPick = originPicker
            )

            PlaceField(
                label = "Destination",
                value = uiState.destination?.label,
                placeholder = "Search destination",
                onPick = destinationPicker
            )

            ArriveByTimeInput(
                state = arriveByState
            )

            TravelModePicker(
                selected = uiState.travelMode,
                onSelected = onTravelModeSelected
            )

            DaysOfWeekChips(selected = uiState.activeDays, onToggle = onToggleDay)
        }
    }
}

@Composable
private fun PlaceField(
    label: String,
    value: String?,
    placeholder: String,
    onPick: () -> Unit
) {
    var hasLaunchedFromFocus by remember { mutableStateOf(false) }

    OutlinedTextField(
        value = value.orEmpty(),
        onValueChange = {
            // User intent to type/search triggers Places autocomplete.
            onPick()
        },
        modifier = Modifier
            .fillMaxWidth()
            .onFocusChanged { focusState ->
                if (focusState.isFocused && !hasLaunchedFromFocus) {
                    hasLaunchedFromFocus = true
                    onPick()
                } else if (!focusState.isFocused) {
                    hasLaunchedFromFocus = false
                }
            },
        label = { Text(label) },
        placeholder = { Text(placeholder) },
        singleLine = true,
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
        trailingIcon = {
            IconButton(onClick = onPick) {
                Icon(
                    imageVector = Icons.Default.Search,
                    contentDescription = "Search $label"
                )
            }
        }
    )
}

@Composable
private fun TravelModePicker(
    selected: TravelMode,
    onSelected: (TravelMode) -> Unit
) {
    Column(Modifier.fillMaxWidth()) {
        Text("Travel mode", style = MaterialTheme.typography.labelLarge)
        Spacer(Modifier.height(8.dp))
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            val modeLabels = mapOf(
                TravelMode.DRIVE to "Drive",
                TravelMode.TRANSIT to "Transit",
                TravelMode.WALK to "Walk",
                TravelMode.TWO_WHEELER to "2W",
                TravelMode.BICYCLE to "Bike"
            )
            TravelMode.values().forEach { mode ->
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

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ArriveByTimeInput(
    state: androidx.compose.material3.TimePickerState
) {
    Column(Modifier.fillMaxWidth()) {
        Text("Arrive by", style = MaterialTheme.typography.labelLarge)
        Spacer(Modifier.height(6.dp))
        TimeInput(state = state)
    }
}

@Composable
private fun DaysOfWeekChips(
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
